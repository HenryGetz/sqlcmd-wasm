import { chromium } from 'playwright';

function withAutomationFlag(targetUrl) {
  const parsedUrl = new URL(targetUrl);

  if (!parsedUrl.searchParams.has('automation')) {
    parsedUrl.searchParams.set('automation', '1');
  }

  return parsedUrl.toString();
}

export class SqlCmdBrowserClient {
  #browser;
  #context;
  #page;
  #lastTranscript = '';

  constructor(page) {
    this.#page = page;
  }

  static async connect({
    url = 'http://127.0.0.1:5176/',
    headless = true,
    timeoutMs = 30_000,
  } = {}) {
    const browser = await chromium.launch({
      headless,
    });

    const context = await browser.newContext();
    const page = await context.newPage();

    const targetUrl = withAutomationFlag(url);

    await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs,
    });

    await page.waitForFunction(() => Boolean(window.__sqlcmdAutomation), {
      timeout: timeoutMs,
    });

    const client = new SqlCmdBrowserClient(page);
    client.#browser = browser;
    client.#context = context;
    client.#lastTranscript = await client.getTranscript();

    return client;
  }

  async close() {
    if (this.#context) {
      await this.#context.close();
    }

    if (this.#browser) {
      await this.#browser.close();
    }
  }

  async injectInput(chunk) {
    await this.#page.evaluate((inputChunk) => {
      window.__sqlcmdAutomation.injectInput(inputChunk);
    }, chunk);
  }

  async injectLine(line) {
    await this.#page.evaluate((lineToInject) => {
      window.__sqlcmdAutomation.injectLine(lineToInject);
    }, line);
  }

  async waitForIdle(timeoutMs = 5_000) {
    return this.#page.evaluate(async (limitMs) => {
      return window.__sqlcmdAutomation.waitForIdle(limitMs);
    }, timeoutMs);
  }

  async getTranscript() {
    return this.#page.evaluate(() => {
      return window.__sqlcmdAutomation.getTranscript();
    });
  }

  async getTranscriptDelta() {
    const currentTranscript = await this.getTranscript();

    let delta = currentTranscript;

    if (currentTranscript.startsWith(this.#lastTranscript)) {
      delta = currentTranscript.slice(this.#lastTranscript.length);
    }

    this.#lastTranscript = currentTranscript;

    return {
      full: currentTranscript,
      delta,
    };
  }

  async sendLineAndRead(line, timeoutMs = 5_000) {
    await this.injectLine(line);
    await this.waitForIdle(timeoutMs);
    await this.waitForIdle(timeoutMs);

    return this.getTranscriptDelta();
  }

  async sendRawAndRead(rawInput, timeoutMs = 5_000) {
    await this.injectInput(rawInput);
    await this.waitForIdle(timeoutMs);

    return this.getTranscriptDelta();
  }

  async sendScriptAndRead(scriptText, timeoutMs = 5_000) {
    const normalizedScript = scriptText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const scriptLines = normalizedScript.split('\n');

    if (scriptLines.length > 0 && scriptLines[scriptLines.length - 1] === '') {
      scriptLines.pop();
    }

    for (const line of scriptLines) {
      await this.injectLine(line);
      await this.waitForIdle(timeoutMs);
    }

    return this.getTranscriptDelta();
  }

  async clearPersistedAndRuntimeState() {
    await this.sendLineAndRead('WIPE');
  }
}
