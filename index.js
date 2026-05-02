require('dotenv').config();

const fs = require('fs');
const linkAfiliados = require('./links-afiliados.json');

function gerarLinkAmazon(url) {
    try {
        const u = new URL(url);
        u.searchParams.set('tag', process.env.AMAZON_TAG);
        return u.toString();
    } catch {
        return url;
    }
}

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
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
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ],
        protocolTimeout: 120000
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

async function pegarImagemProduto(page, linkProduto) {
    try {
        const urlLimpa =  linkProduto.split('?')[0];
        await page.goto(urlLimpa, { waitUntil: 'domcontentloaded', timeout: 30000});

        const imagem = await page.evaluate(() => {
            const img =
                document.querySelector('#landingImage') ||
                document.querySelector('#imgBlkFront') ||
                document.querySelector('.a-dynamic-image');

            if (!img) return null;

            const dados = img.getAttribute('data-a-dynamic-image');
            if (dados) {
                try {
                    const urls = Object.keys(JSON.parse(dados));
                    const melhorUrl = urls.reduce((melhor, url) => {
                        const match = url.match(/_(\d+)x(\d+)_/);
                        if (!match) return melhor;
                        const area = parseInt(match[1]) * parseInt(match[2]);
                        const melhorMatch = melhor.match(/_(\d+)x(\d+)_/);
                        if (!melhorMatch) return url;
                        const melhorArea = parseInt(melhorMatch[1]) * parseInt(melhorMatch[2]);
                        return area > melhorArea ? url : melhor;
                    }, urls[0]);
                    return melhorUrl;
                } catch {
                    return null;
                }
            }

            return img.src || null;
        });

        const imagemHD = imagem 
            ? imagem.replace(/\._[A-Z0-9_,]+_\./g, '.')
            : null;

        return imagemHD;

    } catch (err) {
        console.log('❌ Erro ao pegar imagem:', err.message);
        return null;
    }
}

async function buscarProdutoAmazon(page, termoBusca) {
    try {
        const termo = termoBusca
        .replace(/[^\w\sÀ-ú]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 60);

        console.log('🔍 Buscando na Amazon:', termo);

        const url = `https://www.amazon.com.br/s?k=${encodeURIComponent(termo)}`;
        
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });

        await page.waitForSelector('[data-asin]', { timeout: 10000 });

        const produto = await page.evaluate(() => {
            const cards = [...document.querySelectorAll('[data-component-type="s-search-result"]')]
            .filter(el => el.dataset.asin && el.dataset.asin.length > 0);

            for (const card of cards) {
                const asin = card.dataset.asin;
                const titulo = card.querySelector('h2 span')?.innerText?.trim();
                const preco = card.querySelector('.a-price .a-offscreen')?.innerText?.trim();
                const imagem = card.querySelector('img.s-image')?.getAttribute('src') ||
                            card.querySelector('img.s-image')?.getAttribute('data-src') || '';

                if (titulo && preco && asin) {
                    return {
                        asin, 
                        titulo,
                        preco,
                        imagem,
                        link: `https://www.amazon.com.br/dp/${asin}`
                    };
                }
            }
            return null;
        });

        if (!produto) return null;

        produto.link = gerarLinkAmazon(produto.link);
        return produto;
    } catch (err) {
        console.log('❌ Erro ao buscar na Amazon:', err.message);
        return null;
    }
}

function extrairIdProdutoML(link) {
    const match = link.match(/(MLB\d+)/);
    return match ? match[1] : null;
}

function salvarPendenteAfiliado(produto) {
    try {
        const pendentes = JSON.parse(fs.readFileSync('./pendentes-afiliado.json', 'utf-8'));

        const jaExiste = pendentes.some(item => item.id === produto.id);

        if (!jaExiste) {
            pendentes.push(produto);
            fs.writeFileSync('./pendentes-afiliado.json', JSON.stringify(pendentes, null, 2));
            console.log('💾 Produto salvo em pendentes:', produto.id);
        }
    } catch (err) {
        console.log('Erro ao salvat pendente', err.message);
    }
}

function obterLinkFinal(produtoML) {
    const idProduto = extrairIdProdutoML(produtoML.link);

    if (!idProduto) {
        return produtoML.link;
    }

    const linkAfiliado = linkAfiliados[idProduto];

    if (linkAfiliado) {
        return linkAfiliado;
    }

    salvarPendenteAfiliado({
        id: idProduto,
        titulo: produtoML.titulo,
        link: produtoML.link
    });

    return produtoML.link;
}

client.on('qr', qr => {
    qrcode.generate(qr, { small: true });
});

async function iniciarScraper() {
    browser = await puppeteer.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gru'
        ],
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

            promo.titulo = promo.titulo
                 .replace(/\[.*?\]/g, '')   
                 .replace(/\(.*?\)/g, '')   
                 .replace(/^[\W\d\s,./+|-]+/g, '')
                 .replace(/\s+/g, ' ')
                 .trim();

            const tituloInvalido = promo.titulo.length < 15;
            
            if (tituloInvalido) {
                console.log('⏭️ Ignorando promo genérica:', promo.titulo.slice(0, 40));
                enviados.add(idUnico);
                continue;
            }

         if (!enviados.has(idUnico)) {
                const produtoAmazon = await buscarProdutoAmazon(page, promo.titulo);

                if (!produtoAmazon) {
                    console.log('❌ Nenhum resultado na Amazon');
                    continue;
                }

                const linkFinal = produtoAmazon.link;

                const imagemProduto = await pegarImagemProduto(page, linkFinal);
                console.log('🖼️ Imagem:', imagemProduto ? 'encontrada' : 'não encontrada');
                
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

👉 ${linkFinal}`;
                } else {
                    mensagem = `${destaque}

${promo.titulo}

💸 Por apenas ${produtoAmazon.preco}

⚡ Corre que pode acabar

🔗 ${linkFinal}`;
                }

                if (imagemProduto) {
                    await telegramBot.sendPhoto(TELEGRAM_CHAT_ID, imagemProduto, {
                        caption: mensagem
                    });
                } else {
                    await telegramBot.sendMessage(TELEGRAM_CHAT_ID, mensagem, {
                        disable_web_page_preview: false
                    });
                }

            if (imagemProduto) {
                const media = await MessageMedia.fromUrl(imagemProduto);
                await client.sendMessage(grupoId, media, { caption: mensagem });
            } else {
                await client.sendMessage(grupoId, mensagem);
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