import type { AppLanguage } from "$lib/config/document";

export type PaletteItemKind = "command" | "tab" | "profile" | "theme";

export type PaletteItem = {
  id: string;
  kind: PaletteItemKind;
  title: string;
  scope: string;
  keywords: string[];
  shortcut?: string;
  disabledReason?: string;
  contextScore?: number;
  recentScore?: number;
};

export type PaletteSearchOptions = {
  language: AppLanguage;
  limit?: number;
  includeDisabledExact?: boolean;
};

export type PaletteSearchResult = PaletteItem & {
  score: number;
};

type LocalizedText = {
  en: string;
  zh: string;
};

export type StaticPaletteCommand = {
  id: string;
  title: LocalizedText;
  scope: LocalizedText;
  keywords: {
    en: string[];
    zh: string[];
    pinyin?: string[];
  };
  shortcut?: string;
};

export function localizeCommand(command: StaticPaletteCommand, language: AppLanguage): PaletteItem {
  return {
    id: command.id,
    kind: command.id.startsWith("ui.theme.") ? "theme" : "command",
    title: command.title[language],
    scope: command.scope[language],
    shortcut: command.shortcut,
    keywords: [
      command.title[language],
      command.title.en,
      ...command.keywords[language],
      ...command.keywords.en,
      ...(command.keywords.pinyin ?? []),
    ],
  };
}

export function searchPaletteItems(
  items: PaletteItem[],
  query: string,
  options: PaletteSearchOptions,
): PaletteSearchResult[] {
  const normalizedQuery = normalizeSearchText(query);
  const limit = options.limit ?? 12;
  return items
    .map((item, index) => scorePaletteItem(item, normalizedQuery, index, options.includeDisabledExact === true))
    .filter((result): result is PaletteSearchResult & { sortIndex: number } => result !== null)
    .sort((first, second) => second.score - first.score || first.sortIndex - second.sortIndex)
    .slice(0, limit)
    .map(({ sortIndex: _sortIndex, ...result }) => result);
}

function scorePaletteItem(
  item: PaletteItem,
  normalizedQuery: string,
  sortIndex: number,
  includeDisabledExact: boolean,
): (PaletteSearchResult & { sortIndex: number }) | null {
  const haystacks = searchableTexts(item);
  const textScore = normalizedQuery ? bestTextScore(haystacks, normalizedQuery) : 40;
  if (textScore === 0) return null;
  if (item.disabledReason && !(includeDisabledExact && textScore >= 900)) return null;
  return {
    ...item,
    score: textScore + (item.contextScore ?? 0) + (item.recentScore ?? 0) + kindBoost(item.kind),
    sortIndex,
  };
}

function searchableTexts(item: PaletteItem): string[] {
  return [item.title, item.scope, ...item.keywords].map(normalizeSearchText).filter((text) => text.length > 0);
}

function bestTextScore(haystacks: string[], query: string): number {
  let best = 0;
  for (const text of haystacks) {
    best = Math.max(best, textScore(text, query));
  }
  return best;
}

function textScore(text: string, query: string): number {
  if (text === query) return 1000;
  if (text.startsWith(query)) return 850 - Math.min(text.length - query.length, 80);
  const wordScore = wordPrefixScore(text, query);
  if (wordScore > 0) return wordScore;
  const containsIndex = text.indexOf(query);
  if (containsIndex >= 0) return 620 - Math.min(containsIndex, 120);
  return orderedFuzzyScore(text, query);
}

function wordPrefixScore(text: string, query: string): number {
  const words = text.split(" ").filter(Boolean);
  const index = words.findIndex((word) => word.startsWith(query));
  if (index === -1) return 0;
  return 760 - index * 20;
}

function orderedFuzzyScore(text: string, query: string): number {
  let searchFrom = 0;
  let distance = 0;
  let previousIndex = -1;
  for (const character of query) {
    const index = text.indexOf(character, searchFrom);
    if (index === -1) return 0;
    if (previousIndex >= 0) distance += index - previousIndex - 1;
    previousIndex = index;
    searchFrom = index + 1;
  }
  return Math.max(120, 520 - distance * 12 - (text.length - query.length));
}

function kindBoost(kind: PaletteItemKind): number {
  if (kind === "command") return 12;
  if (kind === "theme") return 8;
  return 0;
}

export function normalizeSearchText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[_./:|()[\]{}-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
