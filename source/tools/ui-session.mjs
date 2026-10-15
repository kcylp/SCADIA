import fs from 'node:fs';
import path from 'node:path';

// Exercise the real login form; credentials and tokens never enter the report.
export async function login({ root, send, evaluate }) {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'project/_appdata/video-events.json'), 'utf8'));
    const wait = async (expression, description) => {
        for (let i = 0; i < 60; i++) {
            if (await evaluate(expression)) return;
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        throw new Error(description);
    };
    await send('Page.navigate', { url: 'http://127.0.0.1:1881/scenes' });
    await wait(`!!document.querySelector('[data-login], app-login input')`, 'Login entry did not appear');
    await evaluate(`document.querySelector('[data-login]')?.click()`);
    await wait(`!!document.querySelector('app-login button[type=submit]') && document.querySelectorAll('app-login form input').length >= 2`, 'Login dialog did not open');
    await evaluate(`(() => {
        const inputs = [...document.querySelectorAll('app-login input')].filter(e => e.type !== 'hidden');
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        set.call(inputs[0], ${JSON.stringify(cfg.user)});
        inputs[0].dispatchEvent(new Event('input', {bubbles:true}));
        set.call(inputs[1], ${JSON.stringify(cfg.password)});
        inputs[1].dispatchEvent(new Event('input', {bubbles:true}));
        document.querySelector('app-login form').requestSubmit();
    })()`);
    await wait(`!!window.scadiaAccessToken && !document.querySelector('app-login')`, 'Login failed or timed out');
    await wait(`(async () => {
        const r = await fetch('/api/ai/scenes', {headers:{'x-access-token':window.scadiaAccessToken}});
        return r.ok;
    })()`, 'Authenticated scene API unavailable');
}
