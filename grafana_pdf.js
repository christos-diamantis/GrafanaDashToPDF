'use strict';

const puppeteer = require('puppeteer');
const fetch = require('node-fetch');
const fs = require('fs');

console.log("Script grafana_pdf.js started...");

const url = process.argv[2];
const auth_string = process.argv[3];
let outfile = process.argv[4];

const width_px = parseInt(process.env.PDF_WIDTH_PX, 10) || 1200;
console.log("PDF width set to:", width_px);

const auth_header = 'Basic ' + Buffer.from(auth_string).toString('base64');

(async () => {
    try {
        console.log("URL provided:", url);
        console.log("Checking URL accessibility...");
        const response = await fetch(url, {
            method: 'GET',
            headers: {'Authorization': auth_header}
        });

        if (!response.ok) {
            throw new Error(`Unable to access URL. HTTP status: ${response.status}`);
        }

        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.includes('text/html')) {
            throw new Error("The URL provided is not a valid Grafana instance.");
        }

        let finalUrl = url;
        // Improved kiosk mode handling
        if(process.env.FORCE_KIOSK_MODE === 'true') {
            console.log("Checking if kiosk mode is enabled.");
            const urlObj = new URL(finalUrl);
            if (!urlObj.searchParams.has('kiosk')) {
                console.log("Kiosk mode not enabled. Enabling it.");
                urlObj.searchParams.set('kiosk', '1');
                finalUrl = urlObj.toString();
            }
            console.log("Final URL with kiosk mode:", finalUrl);
        }


        console.log("Starting browser...");
        const browser = await puppeteer.launch({
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
            headless: true,
            args: [
              '--no-sandbox', 
              '--disable-setuid-sandbox', 
              '--disable-gpu',
              '--disable-dev-shm-usage'
            ]
        });

        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        console.log("Browser started...");

        await page.setExtraHTTPHeaders({'Authorization': auth_header});
        await page.setDefaultNavigationTimeout(process.env.PUPPETEER_NAVIGATION_TIMEOUT || 120000);

        await page.setViewport({
            width: width_px,
            height: 1800,
            deviceScaleFactor: 2,
            isMobile: false
        });

        console.log("Navigating to URL...");
        await page.goto(finalUrl, {
          waitUntil: ['networkidle0', 'domcontentloaded'],
          timeout: 60000
        });
        console.log("Page loaded...");

        // Wait for dashboard to fully render
        await page.waitForSelector('.react-grid-item', { timeout: 30000 });
        console.log("Dashboard content loaded");

        // Wait for any animations to complete
        await page.waitForTimeout(2000);

        await page.evaluate(() => {
            let infoCorners = document.getElementsByClassName('panel-info-corner');
            for (let el of infoCorners) {
                el.hidden = true;
            }
            let resizeHandles = document.getElementsByClassName('react-resizable-handle');
            for (let el of resizeHandles) {
                el.hidden = true;
            }
        });

        let dashboardName = 'output_grafana';
        let date = new Date().toISOString().split('T')[0];
        let addRandomStr = false;

        if (process.env.EXTRACT_DATE_AND_DASHBOARD_NAME_FROM_HTML_PANEL_ELEMENTS === 'true') {
            console.log("Extracting dashboard name and date from the HTML page...");
            let scrapedDashboardName = await page.evaluate(() => {
                const dashboardElement = document.getElementById('display_actual_dashboard_title');
                return dashboardElement ? dashboardElement.innerText.trim() : null;
            });

            let scrapedDate = await page.evaluate(() => {
                const dateElement = document.getElementById('display_actual_date');
                return dateElement ? dateElement.innerText.trim() : null;
            });

            let scrapedPanelName = await page.evaluate(() => {
                const scrapedPanelName = document.querySelectorAll('h6');
                if (scrapedPanelName.length > 1) { // Multiple panels detected
                    console.log("Multiple panels detected. Unable to fetch a unique panel name. Using default value.")
                    return null;
                }
                if (scrapedPanelName[0] && scrapedPanelName[0].innerText.trim() === '') {
                    console.log("Empty panel name detected. Using default value.")
                    return null;
                }
                return scrapedPanelName[0] ? scrapedPanelName[0].innerText.trim() : null;
            });

            if (scrapedPanelName && !scrapedDashboardName) {
                console.log("Panel name fetched:", scrapedPanelName);
                dashboardName = scrapedPanelName;
                addRandomStr = false;
            } else if (!scrapedDashboardName) {
                console.log("Dashboard name not found. Using default value.");
                addRandomStr = true;
            } else {
                console.log("Dashboard name fetched:", scrapedDashboardName);
                dashboardName = scrapedDashboardName;
            }

            if (scrapedPanelName && !scrapedDate) {
                const urlParts = new URL(url);
                const from = urlParts.searchParams.get('from');
                const to = urlParts.searchParams.get('to');
                if (from && to) {
                    const fromDate = isNaN(from) ? from.replace(/[^\w\s-]/g, '_') : new Date(parseInt(from)).toISOString().split('T')[0];
                    const toDate = isNaN(to) ? to.replace(/[^\w\s-]/g, '_') : new Date(parseInt(to)).toISOString().split('T')[0];
                    date = `${fromDate}_to_${toDate}`;
                } else {
                    // using date in URL
                    date = new Date().toISOString().split('T')[0];
                }
            } else if (!scrapedDate) {
                console.log("Date not found. Using default value.");
            } else {
                console.log("Date fetched:", date);
                date = scrapedDate;
            }
        } else {
            console.log("Extracting dashboard name and date from the URL...");
            const urlParts = new URL(url);
            const pathSegments = urlParts.pathname.split('/');
            dashboardName = pathSegments[pathSegments.length - 1] || dashboardName;
            const from = urlParts.searchParams.get('from');
            const to = urlParts.searchParams.get('to');
            if (from && to) {
                const fromDate = isNaN(from) ? from.replace(/[^\w\s-]/g, '_') : new Date(parseInt(from)).toISOString().split('T')[0];
                const toDate = isNaN(to) ? to.replace(/[^\w\s-]/g, '_') : new Date(parseInt(to)).toISOString().split('T')[0];
                date = `${fromDate}_to_${toDate}`;
            } else {
                date = new Date().toISOString().split('T')[0];
            }
            console.log("Dashboard name fetched from URL:", dashboardName);
            console.log("Trying to fetch the panel name from the page...")
            let scrapedPanelName = await page.evaluate(() => {
                const scrapedPanelName = document.querySelectorAll('h6');
                console.log(scrapedPanelName)
                if (scrapedPanelName.length > 1) { // Multiple panels detected
                    console.log("Multiple panels detected. Unable to fetch a unique panel name. Using default value.")
                    return null;
                }
                if (scrapedPanelName[0] && scrapedPanelName[0].innerText.trim() === '') {
                    console.log("Empty panel name detected. Using default value.")
                    return null;
                }
                return scrapedPanelName[0] ? scrapedPanelName[0].innerText.trim() : null;
            });

            if (scrapedPanelName) {
                console.log("Panel name fetched:", scrapedPanelName);
                dashboardName = scrapedPanelName;
                addRandomStr = false;
            }

            console.log("Date fetched from URL:", date);
        }

        outfile = `./output/${dashboardName.replace(/\s+/g, '_')}_${date.replace(/\s+/g, '_')}${addRandomStr ? '_' + Math.random().toString(36).substring(7) : ''}.pdf`;

        const loginPageDetected = await page.evaluate(() => {
            const resetPasswordButton = document.querySelector('a[href*="reset-email"]');
            return !!resetPasswordButton;
        })

        if (loginPageDetected) {
            throw new Error("Login page detected. Check your credentials.");
        }

        if(process.env.DEBUG_MODE === 'true') {
            const documentHTML = await page.evaluate(() => {
                return document.querySelector("*").outerHTML;
            });
            if (!fs.existsSync('./debug')) {
                fs.mkdirSync('./debug');
            }
            const filename = `./debug/debug_${dashboardName.replace(/\s+/g, '_')}_${date.replace(/\s+/g, '_')}${'_' + Math.random().toString(36).substring(7)}.html`;
            fs.writeFileSync(filename, documentHTML);
            console.log("Debug HTML file saved at:", filename);

        }

        const totalHeight = await page.evaluate(() => {
            const panelContent = document.querySelector('.css-kuoxoh-panel-content');
            if (panelContent) {
                return panelContent.scrollHeight;
            }
            const reactGridItem = document.querySelector('.react-grid-item');
            if (reactGridItem) {
                return reactGridItem.scrollHeight;
            }
            return document.body.scrollHeight;
        });

        if (!totalHeight) {
            throw new Error("Unable to determine the page height. The selector '.scrollbar-view' might be incorrect or missing.");
        } else {
            console.log("Page height adjusted to:", totalHeight);
        }

        // Ensure all conetnt is loaded by scrolling
        await page.evaluate(async () => {
            const scrollableSection = document.querySelector('.scrollbar-view') || window;
            if (scrollableSection) {
                const scrollHeight = scrollableSection.scrollHeight || document.body.scrollHeight;
                const viewportHeight = window.innerHeight;

                let scrollPosition = 0;

                while (scrollPosition < scrollHeight) {
                    scrollableSection.scrollBy(0, viewportHeight);
                    await new Promise(resolve => setTimeout(resolve, 500));
                    scrollPosition += viewportHeight;
                }
            }
        });

        await page.waitForTimeout(3000);

        await page.setViewport({
            width: width_px,
            height: totalHeight,
            deviceScaleFactor: 2,
            isMobile: false
        });

        console.log("Generating PDF...");
        await page.pdf({
            path: outfile,
            width: width_px + 'px',
            height: totalHeight + 'px',
            printBackground: true,
            scale: 1,
            displayHeaderFooter: false,
            margin: {top: 0, right: 0, bottom: 0, left: 0},
            pageRanges: '2'
        });
        console.log(`PDF generated: ${outfile}`);

        await browser.close();
        console.log("Browser closed.");

        process.send({ success: true, path: outfile });
    } catch (error) {
        console.error("Error during PDF generation:", error.message);
        process.send({ success: false, error: error.message });
        process.exit(1);
    }
})();