import { createRequire } from 'module';
const require = createRequire('C:/Users/lucke/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/package.json');
const { chromium } = require('playwright');
const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await page.screenshot({ path: 'shot.png' });
const dims = await page.evaluate(() => {
  const canvas = document.querySelector('.flow-canvas');
  const panel = document.querySelector('.panel-content');
  const cards = [...document.querySelectorAll('.agent-node')].map(c => Math.round(c.getBoundingClientRect().width));
  const cb = canvas.getBoundingClientRect();
  const firstCard = document.querySelectorAll('.agent-node')[0].getBoundingClientRect();
  const lastCard = document.querySelectorAll('.agent-node')[4].getBoundingClientRect();
  return {
    canvasW: Math.round(cb.width), canvasLeft: Math.round(cb.left), canvasRight: Math.round(cb.right),
    panelW: Math.round(panel.getBoundingClientRect().width),
    cards,
    firstCardLeft: Math.round(firstCard.left),
    lastCardRight: Math.round(lastCard.right),
    lastCardBottom: Math.round(lastCard.bottom),
    vw: 1920
  };
});
console.log(JSON.stringify(dims, null, 2));
await browser.close();
