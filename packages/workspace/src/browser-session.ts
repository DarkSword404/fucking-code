import { existsSync, readdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";

const MAX_TEXT = 12_000;
const MAX_ARIA = 16_000;
const ACTION_TIMEOUT = 20_000;

function clip(value: string, max = MAX_TEXT): string {
  return value.length > max ? `${value.slice(0, max)}\n... (truncated)` : value;
}

function playwrightCacheCandidates(): string[] {
  const cache = join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(cache)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(cache)) {
    if (!entry.startsWith("chromium")) continue;
    for (const suffix of [
      join("chrome-linux", "chrome"),
      join("chrome-linux64", "chrome"),
      join("chrome-linux", "headless_shell"),
    ]) {
      const candidate = join(cache, entry, suffix);
      if (existsSync(candidate)) found.push(candidate);
    }
  }
  return found;
}

export function browserExecutable(): string | null {
  const explicit = process.env.BROWSER_EXECUTABLE_PATH?.trim();
  if (explicit && existsSync(explicit)) return explicit;
  try {
    const bundled = chromium.executablePath();
    if (bundled && existsSync(bundled)) return bundled;
  } catch {
    // Playwright browsers are optional; fall back to the system Chrome.
  }
  const candidates = [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    ...playwrightCacheCandidates(),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function inside(root: string, target: string): string {
  const absolute = resolve(root, target);
  const rel = relative(root, absolute);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("path escapes the workspace");
  return absolute;
}

/**
 * One browser page per workbench run. Actions are intentionally small and
 * explicit so the model can inspect a page, interact, and collect evidence
 * without receiving an unbounded DOM dump.
 */
export class BrowserSession {
  private browser: Browser | null = null;
  private page: Page | null = null;

  constructor(
    private readonly root: string,
    private readonly evidenceDir = "docs/qa-evidence",
  ) {}

  private async ensurePage(): Promise<Page> {
    if (this.page) return this.page;
    const executablePath = browserExecutable();
    if (!executablePath) {
      throw new Error(
        "no browser found; install Chrome/Chromium or set BROWSER_EXECUTABLE_PATH",
      );
    }
    this.browser = await chromium.launch({
      executablePath,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
    const context = await this.browser.newContext({
      viewport: { width: 1280, height: 900 },
      ignoreHTTPSErrors: true,
    });
    this.page = await context.newPage();
    this.page.setDefaultTimeout(ACTION_TIMEOUT);
    this.page.setDefaultNavigationTimeout(ACTION_TIMEOUT);
    return this.page;
  }

  async open(url: string): Promise<string> {
    const page = await this.ensurePage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: ACTION_TIMEOUT });
    return this.snapshot();
  }

  async snapshot(): Promise<string> {
    const page = await this.ensurePage();
    const title = await page.title().catch(() => "");
    const url = page.url();
    const aria = await page
      .locator("body")
      .ariaSnapshot()
      .catch(() => "");
    const text = await page
      .locator("body")
      .innerText()
      .catch(() => "");
    const interactive = await page
      .evaluate(() => {
        const elements = Array.from(
          document.querySelectorAll(
            "a,button,input,textarea,select,[role=button],[role=link],[role=tab]",
          ),
        ).slice(0, 200);
        return elements.map((element, index) => {
          const html = element as HTMLElement;
          const input = element as HTMLInputElement;
          const label =
            (html.getAttribute("aria-label") ?? "").trim() ||
            (input.placeholder ?? "").trim() ||
            (html.innerText ?? "").trim().slice(0, 80);
          return {
            index,
            tag: element.tagName.toLowerCase(),
            type: input.type ?? "",
            id: element.id || "",
            name: input.name || "",
            role: element.getAttribute("role") ?? "",
            text: label,
            href: element.getAttribute("href") ?? "",
          };
        });
      })
      .catch(() => []);
    return [
      `URL: ${url}`,
      `Title: ${title}`,
      "",
      "ARIA snapshot:",
      clip(aria, MAX_ARIA),
      "",
      "Interactive elements:",
      interactive.length
        ? interactive
            .map((element) =>
              [
                `#${element.index}`,
                element.tag,
                element.type ? `type=${element.type}` : "",
                element.id ? `id=${element.id}` : "",
                element.name ? `name=${element.name}` : "",
                element.text ? `text=${JSON.stringify(element.text)}` : "",
                element.href ? `href=${element.href}` : "",
              ]
                .filter(Boolean)
                .join(" "),
            )
            .join("\n")
        : "(none)",
      "",
      "Visible text:",
      clip(text, 6_000),
    ].join("\n");
  }

  async click(action: Record<string, unknown>): Promise<string> {
    const page = await this.ensurePage();
    const selector = typeof action.selector === "string" ? action.selector : "";
    const text = typeof action.text === "string" ? action.text : "";
    if (selector) {
      await page.locator(selector).first().click({ timeout: ACTION_TIMEOUT });
    } else if (text) {
      await page.getByText(text, { exact: false }).first().click({ timeout: ACTION_TIMEOUT });
    } else {
      throw new Error("click requires selector or text");
    }
    return this.snapshot();
  }

  async fill(action: Record<string, unknown>): Promise<string> {
    const page = await this.ensurePage();
    const selector = typeof action.selector === "string" ? action.selector : "";
    if (!selector) throw new Error("fill requires selector");
    await page
      .locator(selector)
      .first()
      .fill(String(action.value ?? action.text ?? ""), { timeout: ACTION_TIMEOUT });
    return this.snapshot();
  }

  async press(action: Record<string, unknown>): Promise<string> {
    const page = await this.ensurePage();
    await page.keyboard.press(String(action.key ?? "Enter"));
    return this.snapshot();
  }

  async select(action: Record<string, unknown>): Promise<string> {
    const page = await this.ensurePage();
    const selector = typeof action.selector === "string" ? action.selector : "";
    if (!selector) throw new Error("select requires selector");
    await page
      .locator(selector)
      .first()
      .selectOption(String(action.value ?? ""), { timeout: ACTION_TIMEOUT });
    return this.snapshot();
  }

  async screenshot(action: Record<string, unknown>): Promise<string> {
    const page = await this.ensurePage();
    const requested =
      typeof action.path === "string" && action.path.trim()
        ? action.path.trim()
        : join(this.evidenceDir, `screenshot-${Date.now()}.png`);
    const target = inside(this.root, requested);
    await mkdir(dirname(target), { recursive: true });
    await page.screenshot({ path: target, fullPage: action.fullPage === true });
    return relative(this.root, target);
  }

  async evaluate(action: Record<string, unknown>): Promise<string> {
    const page = await this.ensurePage();
    const script = typeof action.script === "string" ? action.script.trim() : "";
    if (!script) throw new Error("eval requires script");
    const result = await page.evaluate(script);
    let serialized: string;
    try {
      serialized = JSON.stringify(result);
    } catch {
      serialized = String(result);
    }
    return clip(serialized ?? "undefined", 8_000);
  }

  async text(): Promise<string> {
    const page = await this.ensurePage();
    return clip(await page.locator("body").innerText().catch(() => ""));
  }

  async close(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    this.page = null;
    if (browser) await browser.close().catch(() => undefined);
  }
}
