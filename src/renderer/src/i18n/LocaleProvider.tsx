import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react'

import { BUNDLES, EN, format, type MessageKey } from '@shared/i18n/messages'
import {
  resolveLocale,
  type Locale,
  type LocaleSetting,
} from '@shared/i18n/locales'

// Tiny i18n surface, deliberately no library.
//
// Consumers call `useT()` to get a `t(key, vars?)` function. The hook
// returns the resolved Locale + the LocaleSetting (so the picker can
// show "System Default · English" vs an explicit pin).
//
// Missing translations fall through to EN — keeps the renderer working
// while a bundle is still being filled out.

interface LocaleContextValue {
  setting: LocaleSetting
  locale: Locale
  setSetting: (next: LocaleSetting) => void
  t: (key: MessageKey, vars?: Record<string, string | number>) => string
}

const FALLBACK_CTX: LocaleContextValue = {
  setting: 'auto',
  locale: 'en',
  setSetting: () => {},
  t: (key, vars) => format(EN[key], vars),
}

const LocaleContext = createContext<LocaleContextValue>(FALLBACK_CTX)

export function LocaleProvider({
  setting,
  osLocale,
  setSetting,
  children,
}: {
  setting: LocaleSetting
  osLocale: string
  setSetting: (next: LocaleSetting) => void
  children: ReactNode
}): JSX.Element {
  const locale = useMemo(() => resolveLocale(setting, osLocale), [setting, osLocale])

  const t = useCallback(
    (key: MessageKey, vars?: Record<string, string | number>): string => {
      const bundle = BUNDLES[locale] ?? EN
      const template = bundle[key] ?? EN[key]
      return format(template, vars)
    },
    [locale],
  )

  const value = useMemo<LocaleContextValue>(
    () => ({ setting, locale, setSetting, t }),
    [setting, locale, setSetting, t],
  )

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
}

export function useT(): LocaleContextValue {
  return useContext(LocaleContext)
}
