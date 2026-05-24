import { defaultLanguage, type AppLanguage } from "$lib/config/document";
import { messages, type MessageKey } from "./messages";

let currentLanguage = $state<AppLanguage>(defaultLanguage());

export function setLanguage(language: AppLanguage) {
  currentLanguage = language;
}

export function language() {
  return currentLanguage;
}

export function t(key: MessageKey): string {
  return messages[currentLanguage][key];
}
