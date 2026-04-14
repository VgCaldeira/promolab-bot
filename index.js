const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const cron = require('node-cron');
const axios = require('axios');
const cheerio = require('cheerio');

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox']
    }
});

const grupoId = '120363421936203640@g.us';

// evita repetição
const enviados = new Set();

// QR
client.on('qr', qr => {
    qrcode.generate(qr, { small: true });
});

// Função promoções
async function pegarPromocoes() {
    try {
        const { data } = await axios.get('https://www.pelando.com.br/');
        const $ = cheerio.load(data);

        const promocoes = [];

        $('a.thread-link').each((i, el) => {
            const titulo = $(el).text().trim();
            const link = 'https://www.pelando.com.br' + $(el).attr('href');

            if (titulo && link) {
                promocoes.push({ titulo, link });
            }
        });

        return promocoes.slice(0, 10);
    } catch (err) {
        console.log('Erro ao buscar promos:', err.message);
        return [];
    }
}

//  Quando conecta
client.on('ready', async () => {
    console.log('Bot Conectado!');

    //  ENVIA AS ÚLTIMAS IMEDIATAMENTE
    console.log('📦 Enviando últimas promoções...');
    const promosIniciais = await pegarPromocoes();

    for (let promo of promosIniciais) {
        const mensagem = `🔥 ${promo.titulo}

👉 ${promo.link}`;

        await client.sendMessage(grupoId, mensagem);
        enviados.add(promo.link);
    }

    console.log('✅ Inicial enviado!');

    //MONITORA NOVAS PROMOÇÕES
    cron.schedule('*/1 * * * *', async () => {
        console.log('🔎 Buscando novas promoções...');

        const promos = await pegarPromocoes();

        for (let promo of promos) {
            if (!enviados.has(promo.link)) {
                const mensagem = `🔥 ${promo.titulo}

👉 ${promo.link}`;

                await client.sendMessage(grupoId, mensagem);
                enviados.add(promo.link);

                console.log('🆕 Nova promo enviada!');
            }
        }
    });
});

client.initialize();