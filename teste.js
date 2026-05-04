require('dotenv').config();
const puppeteer = require('puppeteer');

(async () => {
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36');
    
    await page.goto('https://www.pelando.com.br/recentes', { 
        waitUntil: 'networkidle2',
        timeout: 30000
    });

    await new Promise(r => setTimeout(r, 5000));
    
    const resultado = await page.evaluate(() => {
        const links = [...document.querySelectorAll('a')]
            .filter(a => a.href.includes('/d/') && 
                        !a.href.includes('#') && 
                        a.getAttribute('aria-label') &&
                        a.getAttribute('aria-label') !== 'Ver promoção');

        return links.slice(0, 5).map(el => {
            // Sobe 3 níveis
            let container = el;
            for (let i = 0; i < 3; i++) {
                container = container?.parentElement;
            }
            return {
                titulo: el.getAttribute('aria-label'),
                textoContainer: container?.innerText?.slice(0, 150),
                ehAmazon: container?.innerText?.toLowerCase().includes('amazon')
            };
        });
    });
    
    console.log(JSON.stringify(resultado, null, 2));
    await browser.close();
})();