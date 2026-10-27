import { readFileSync } from 'node:fs'

/** Built once with the frontend and shipped with the source. Never shell out per trade. */
export const buildIdentity: { id: string | null; builtAt: string | null } = (() => {
  try {
    const value = JSON.parse(readFileSync(new URL('../../dashboard-dist/build.json', import.meta.url), 'utf8'))
    return { id: typeof value.id === 'string' ? value.id : null, builtAt: typeof value.builtAt === 'string' ? value.builtAt : null }
  } catch { return { id: null, builtAt: null } }
})()
