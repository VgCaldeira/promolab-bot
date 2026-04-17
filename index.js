const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const cron = require('node-cron');
const puppeteer = require('puppeteer');

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

client.on('qr', qr => {
    qrcode.generate(qr, { small: true });
});

async function iniciarScraper() {
    browser = await puppeteer.launch({
        headless: false,
        args: ['--no-sandbox']
    });

    page = await browser.newPage();
}

async function pegarPromocoes() {
    try {
        if (!page) return [];

        await page.goto('https://www.pelando.com.br/recentes', {
            waitUntil: 'domcontentloaded'
        });

        await page.waitForSelector('a[href*="/d/"]', { timeout: 15000 });

        const promocoes = await page.evaluate(() => {
            const itens = [];
            const vistos = new Set();

            document.querySelectorAll('a[href*="/d/"]').forEach(el => {
                const titulo = el.innerText.trim();
                const link = el.href;

                if (
                    titulo &&
                    titulo.length > 20 &&
                    !vistos.has(link)
                ) {
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

client.on('ready', async () => {
    console.log('Bot Conectado!');

    await iniciarScraper();

    const promosIniciais = await pegarPromocoes();
    console.log('Inicial:', promosIniciais.length);

    if (promosIniciais.length > 0) {
        for (let promo of promosIniciais) {
            const idUnico = promo.link.split('/d/')[1]?.split('?')[0];
            enviados.add(idUnico);
        }
    }

    cron.schedule('*/30 * * * * *', async () => {
        console.log('🔎 Buscando novas promoções...');

        const promos = await pegarPromocoes();
        console.log('Encontradas:', promos.length);

        if (!promos.length) return;

        for (let promo of promos.reverse()) {
            const idUnico = promo.link.split('/d/')[1]?.split('?')[0];

            if (!enviados.has(idUnico)) {
                
                let destaque = '🔥 OFERTA BOA';

                const titulo = promo.titulo.toLowercase();

                if (titulo.includes('iphone')) {
                    destque = '📱 PROMO DE IPHONE';
                } else if (titulo.includes('rtx') || titulo.includes('placa de vídeo')) {
                    destaque = '🎮 GPU EM PROMOÇÃO';
                } else if (titulo.includes('notebook')) {
                    destaque = '💻 NOTEBOOK EM OFERTA';
                } else if (titulo.includes('tv')) {
                    destaque = '📺 TV COM DESCONTO';
                } else if (titulo.includes('air fryer')) {
                    destaque = '🍟 AIR FRYER EM PROMOÇÃO'
                }

                const mensagem = `${destaque}

                🔥 ${promo.titulo}

                ⚡ Corre que pode acabar rápido

                👉 ${promo.link}`;

                await client.sendMessage(grupoId, mensagem);

                enviados.add(idUnico);

                console.log('🆕 Nova promo enviada!');
            }
        }
    });
});

client.initialize();