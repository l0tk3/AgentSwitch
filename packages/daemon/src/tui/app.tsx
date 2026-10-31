/** `agentswitch config` (docs/tui-v0.md): this node's settings in the terminal, laid out as the Mac's Settings window —
 *  the pages on the left, the page on the right; a question takes the page's place while it is asked. Tab (or → and
 *  ←) moves between the two; L changes the language, kept in node.json; Q leaves. */

import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { useMemo, useState, type ReactNode } from "react";
import { LOCALE_NAMES, LOCALES, messages, type Locale } from "../i18n/index.js";
import type { ConfigDeps } from "./deps.js";
import { AgentsPage } from "./pages/agents.js";
import { ContextPage } from "./pages/context.js";
import { EnvironmentPage } from "./pages/environment.js";
import { ExtensionsPage } from "./pages/extensions.js";
import { KeysPage } from "./pages/keys.js";
import { ModelsPage } from "./pages/models.js";
import { NodePage } from "./pages/node.js";
import { PermissionsPage } from "./pages/permissions.js";
import { COLOR, UiProvider, useUi, useWords, WordsContext } from "./ui.js";

/** In the Mac's order: the app's own pages, then Dispatch's (under a heading of their own). */
export const PAGES = ["agents", "models", "permissions", "keys", "node", "environment", "context", "extensions"] as const;
export type PageId = (typeof PAGES)[number];
const DISPATCH_FROM: PageId = "context";

const VIEWS: Readonly<Record<PageId, (p: PageProps) => ReactNode>> = {
  agents: AgentsPage, models: ModelsPage, permissions: PermissionsPage, keys: KeysPage, node: NodePage,
  environment: EnvironmentPage, context: ContextPage, extensions: ExtensionsPage,
};

export type PageProps = {
  readonly deps: ConfigDeps;
  /** The page has the keys (not the list of pages, not a question). */
  readonly active: boolean;
  /** Back to the list of pages. */
  readonly leave: () => void;
  /** Rows the page has. */
  readonly height: number;
  /** Ask for the language, as L does. */
  readonly chooseLanguage: () => void;
};

/** Rows that are not the page's: the title, the status line, the keys, and the space between. */
const CHROME_ROWS = 6;
const SIDEBAR_WIDTH = 18;

export function ConfigApp({ deps, locale: first, page: firstPage = "agents", rows }: { deps: ConfigDeps; locale: Locale; page?: PageId;
  /** The window's height when the terminal does not say (a test). */ rows?: number }) {
  const [locale, setLocale] = useState<Locale>(first);
  const words = useMemo(() => ({ t: messages(locale), locale }), [locale]);
  return (
    <WordsContext.Provider value={words}>
      <UiProvider>{(question, status) => <Shell deps={deps} question={question} status={status} first={firstPage} setLocale={setLocale} fixedRows={rows} />}</UiProvider>
    </WordsContext.Provider>
  );
}

function Shell({ deps, question, status, first, setLocale, fixedRows }: { deps: ConfigDeps; question: ReactNode; status: ReactNode; first: PageId; setLocale: (l: Locale) => void; fixedRows: number | undefined }) {
  const { t, locale } = useWords();
  const ui = useUi();
  const { exit } = useApp();
  const size = useWindowSize();
  const rows = fixedRows ?? size.rows;
  const [page, setPage] = useState<PageId>(first);
  const [inPage, setInPage] = useState(false);
  const height = Math.max(6, rows - CHROME_ROWS);

  const chooseLanguage = () => void (async () => {
    const chosen = await ui.pick({ title: t.app.language, options: LOCALES.map((l) => ({ value: l, label: LOCALE_NAMES[l], hint: l })), initial: locale });
    if (!chosen || chosen === locale) return;
    setLocale(chosen as Locale);
    if (!deps.remote) {
      try { deps.node.write({ ...deps.node.read(), language: chosen }); }
      catch (err) { ui.say((err as Error).message, "error"); }
    }
  })();

  useInput((input, key) => {
    if (input === "q" || input === "Q") return exit();
    if (input === "l" || input === "L") return chooseLanguage();
    if (key.tab) return setInPage((v) => !v);
    if (inPage) return;
    const at = PAGES.indexOf(page);
    if (key.upArrow) return setPage(PAGES[(at - 1 + PAGES.length) % PAGES.length]!);
    if (key.downArrow) return setPage(PAGES[(at + 1) % PAGES.length]!);
    if (key.return || key.rightArrow) return setInPage(true);
  }, { isActive: !ui.asking });

  const props: PageProps = { deps, active: inPage && !ui.asking, leave: () => setInPage(false), height, chooseLanguage };
  return (
    <Box flexDirection="column" height={rows}>
      <Box justifyContent="space-between">
        <Text bold>{t.app.title}{deps.remote ? <Text color={COLOR.warn}>{` · ${deps.remote}`}</Text> : null}</Text>
        <Text color={COLOR.dim}>{LOCALE_NAMES[locale]}</Text>
      </Box>
      <Box flexGrow={1} marginTop={1}>
        <Box flexDirection="column" width={SIDEBAR_WIDTH} flexShrink={0} borderStyle="single" borderTop={false} borderBottom={false} borderLeft={false} borderColor={COLOR.dim}>
          {PAGES.map((p) => {
            const here = p === page;
            return (
              <Box key={p} flexDirection="column">
                {p === DISPATCH_FROM ? <Box marginTop={1}><Text color={COLOR.dim}>{t.pages.dispatch}</Text></Box> : null}
                <Text {...(here ? (inPage ? { bold: true } : { color: COLOR.accent, bold: true }) : {})} wrap="truncate-end">{here ? "▸ " : "  "}{t.pages[p]}</Text>
              </Box>
            );
          })}
        </Box>
        <Box flexDirection="column" flexGrow={1} paddingLeft={2}>
          {question ? <Box flexDirection="column">{question}</Box> : null}
          <Box flexDirection="column" display={question ? "none" : "flex"}>
            {deps.remote ? <Text color={COLOR.warn} wrap="wrap">{t.common.readOnly(deps.remote)}</Text> : null}
            {(() => { const View = VIEWS[page]; return <View key={page} {...props} />; })()}
          </Box>
        </Box>
      </Box>
      <Box minHeight={1}>{status}</Box>
      <Text color={COLOR.dim} wrap="truncate-end">
        {/* A question says its own keys. */}
        {question ? " " : (inPage ? [t.keys.move, t.keys.open, t.keys.back, t.keys.pane, t.keys.language, t.keys.quit] : [t.keys.move, t.keys.open, t.keys.pane, t.keys.language, t.keys.quit]).join("   ")}
      </Text>
    </Box>
  );
}
