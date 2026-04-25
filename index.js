require('dotenv').config();

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const cron = require('node-cron');
const puppeteer = require('puppeteer');

const TelegramBot = require('node-telegram-bot-api');

const telegramBot = new TelegramBot(process.env.TELEGRAM_TOKEN, {
    polling: false
});

const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

let openai = null;

if (process.env.USE_OPENAI === 'true') {
    const OpenAI = require('openai');

    openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY
    });
}

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox']
    }
});

const grupoId = '120363421936203640@g.us';

const enviados = new Set();

let browser;
let page;

let chamadasIA = 0;
const LIMITE_IA = 10;

let contadorExecucoes = 0;

let cronIniciado = false;
let buscandoPromocoes = false;

const buscasML = [
    'air fryer',
    'cafeteira',
    'kit ferramenta',
    'suporte celular carro',
    'fone bluetooth',
    'perfume masculino',
    'organizador cozinha'
];

client.on('qr', qr => {
    qrcode.generate(qr, { small: true });
});

async function iniciarScraper() {
    browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox'],
    });

    page = await browser.newPage();

    await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
    );
}

function escolherBuscaML() {
    const indice = Math.floor(Math.random() * buscasML.length);
    return buscasML[indice];
}

async function buscarProdutosML(termo) {
    try {
        if (!page) return [];

        const url = `https://lista.mercadolivre.com.br/${encodeURIComponent(termo)}`;

        await page.goto(url, {
            waitUntil: 'networkidle2'
        });

        await page.waitForSelector('a[href*="mercadolivre.com.br"]', { timeout: 15000 });

        const produtos = await page.evaluate(() => {
            const itens = [];
            const vistos = new Set();

            document.querySelectorAll('a').forEach(el => {
                const titulo = el.querySelector('h2')?.innerText?.trim() || '';
                const link = el.href;

                if (
                    titulo &&
                    titulo.length > 10 &&
                    link &&
                    link.includes('MLB-') &&
                    !vistos.has(link)
                ) {
                    vistos.add(link);
                    itens.push({ titulo, link });
                }
            });
            
            return itens.slice(0, 20);
        });

            return produtos;
        } catch (err) {
            console.log('Erro ao buscar produtos no ML:', err.message);
            return [];
        }
    }

async function pegarPromocoes() {
    try {
        if (!page) return [];

        await new Promise(r => setTimeout(r, 2000));

        await page.goto('https://www.pelando.com.br/recentes', {
            waitUntil: 'networkidle2'
        });

        await page.waitForSelector('a[href*="/d/"]', { timeout: 15000 });

        const promocoes = await page.evaluate(() => {
            const itens = [];
            const vistos = new Set();

            document.querySelectorAll('a[href*="/d/"]').forEach(el => {
                const titulo = el.innerText.trim();
                const link = el.href;
               
                if ( titulo && titulo.length > 20 && !vistos.has(link)) {
                    vistos.add(link);
                    itens.push({ titulo, link });
                }
            });

            return itens.slice(0, 20);
        });

        return promocoes;
    } catch (err) {
        console.log('Erro ao buscar promos:', err.message);
        return [];
    }
}

async function pegarDetalhesPromo(link) {
    try {
        const novaPagina = await browser.newPage();

        await novaPagina.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
        );

        await novaPagina.goto(link, {
            waitUntil: 'domcontentloaded'
        });

        await new Promise(r => setTimeout(r, 2000));

        const dados = await novaPagina.evaluate(() => {
            const textoOriginal = document.body.innerText || '';
            const textoPagina = textoOriginal.toLowerCase();

            const precos = textoPagina.match(/R\$\s?\d{1,3}(?:\.\d{3})*,\d{2}/g) || [];

            const precoAtual = (precos[0] || '').replace(/\n/g, ' ');
            const precoAntigo = (precos[1] || '').replace(/\n/g, ' ');

            const ehMercadoLivre = 
                textoPagina.includes('mercado livre') ||
                textoPagina.includes('mercadolivre') ||
                textoPagina.includes('no ml') ||
                textoPagina.includes('mercado livre oficial');

            let linkML = '';

            document.querySelectorAll('a').forEach(a => {
                const href = a.href || '';
                const texto = (a.innerText || '').toLowerCase();

                if (
                   href.includes('mercadolivre') ||
                   href.includes('mercadolibre') ||
                   texto.includes('ir para loja') ||
                   texto.includes('ver oferta') ||
                   texto.includes('pegar promoção')
            ) {
                linkML = href;
            }
        });

            return { precoAtual, precoAntigo, ehMercadoLivre, linkML };
    });

        await novaPagina.close();

        return dados;
    } catch (err) {
        console.log('Erro ao pegar detalhes:', err.message);
        return { precoAtual: '', precoAntigo: '', ehMercadoLivre: false, linkML: '' };
    } 
}

async function gerarCopy(titulo) {
    if (!openai) {
        return `🔥 ${titulo}\n\n⚡ CORRE! preço pode subir a qualquer momento`
    }

    try {
        const resposta = await openai.chat.completions.create({
            model: 'gpt-4.1-mini',
            messages: [
                {
                    role: 'user',
                    content: `Crie uma mensagem curta, persuasiva e com gatilho de urgência para WhatsApp.

Produto: ${titulo}

Formato:
- 1 headline chamativa
- 1 benefício claro
- 1 urgência

Sem texto longo.`
                }
            ]
        });

        return resposta.choices[0].message.content;

    } catch (err) {
        console.log('Erro OpenAI:', err.message);
        return `🔥 ${titulo}\n\n⚡ Corre que pode acabar rápido`;
    }
}

client.on('ready', async () => {
    if (cronIniciado) {
        console.log('Cron já iniciado, ignorando novo ready.');
        return;
    }

    console.log('Bot Conectado!');

    await iniciarScraper();
    cronIniciado = true;

    const promosIniciais = await pegarPromocoes();
    console.log('Inicial:', promosIniciais.length);

    if (promosIniciais.length > 0) {
        for (let promo of promosIniciais) {
            const idUnico = promo.link.split('/d/')[1]?.split('?')[0];
            enviados.add(idUnico);
        }
    }

    cron.schedule('*/3 * * * *', async () => {
    if (contadorExecucoes >= 20) {
        console.log('♻️ Reiniciando navegador...');
        
        await browser.close();
        await iniciarScraper();

        contadorExecucoes = 0;
    }
    
    if (buscandoPromocoes) {
        console.log('Busca já em andamento, pulando esta execução.');
        return;
    }

    buscandoPromocoes = true;

    try {
        console.log('🔎 Buscando novas promoções...');

        contadorExecucoes++;

        const promos = await pegarPromocoes();
        console.log('Encontradas:', promos.length);

        if (!promos.length) return;

        for (let promo of promos.reverse()) {
            const idUnico = promo.link.split('/d/')[1]?.split('?')[0];

         if (!enviados.has(idUnico)) {
             const resultadosML = await buscarProdutosML(promo.titulo);

             if (!resultadosML.length) {
                console.log('Nenhum resultado no ML');
                continue;
             }

             const produtoML = resultadosML[0];
                
                let destaque = '🔥 OFERTA INSANA';

                const titulo = (promo.titulo || '').toLowerCase();

                let usarIA = false;

                if (
                    titulo.includes('iphone') ||
                    titulo.includes('rtx') ||
                    titulo.includes('notebook') ||
                    titulo.includes('tv') ||
                    titulo.includes('air fryer')
                ) {
                    usarIA = true;
                }

                if (titulo.includes('iphone')) {
                    destaque = '📱 PROMO DE IPHONE';
                } else if (titulo.includes('rtx') || titulo.includes('placa de vídeo')) {
                    destaque = '🎮 GPU EM PROMOÇÃO';
                } else if (titulo.includes('notebook')) {
                    destaque = '💻 NOTEBOOK EM OFERTA';
                } else if (titulo.includes('tv')) {
                    destaque = '📺 TV COM DESCONTO';
                } else if (titulo.includes('air fryer')) {
                    destaque = '🍟 AIR FRYER EM PROMOÇÃO';
                }

                let mensagem;

                if (usarIA && chamadasIA < LIMITE_IA) {
                    const copy = await gerarCopy(promo.titulo);
                    chamadasIA++;

                    mensagem = `${destaque}

${copy}

👉 ${promo.link}`;
                } else {
                    mensagem = `${destaque}

${promo.titulo}

${detalhes.precoAntigo ? `De ${detalhes.precoAntigo} ❌` : ''}
${detalhes.precoAtual ? `Por ${detalhes.precoAtual} ✅` : '💸 Preço abaixo do normal'}

⚡ Corre que pode acabar

🔗 ${produtoML.linkML}`;
                }

                await client.sendMessage(grupoId, mensagem);

                try {
                    await telegramBot.sendMessage(TELEGRAM_CHAT_ID, mensagem);
                } catch (err) {
                    console.log('Erro Telegram:', err.message);
                }

                enviados.add(idUnico);

                 if (enviados.size > 500) {
                    console.log('♻️ Limpando histórico de enviados...');
                    enviados.clear();
                }

                console.log('🆕 Nova promo enviada!');
                break;
            }
        }
     } finally {
        buscandoPromocoes = false;
     }
    });
});

client.initialize();