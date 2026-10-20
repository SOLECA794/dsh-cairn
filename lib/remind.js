/**
 * Reminder text.
 *
 * Every character here is billed on every request it appears in, so the rules
 * are: one line per fact, no restating what the model can already see, and no
 * imperative that the model cannot act on. A reminder that says "consider
 * verifying your changes" is worse than nothing — it trains the model to skim.
 * These say *which files*, *which command*, and *what is missing*.
 */

import { escapeTagBody, formatCount } from './core.js'

/** Wrapper tag. Deliberately not `system-reminder`: that is the host's tag. */
export const REMINDER_TAG = 'cairn'

export const REMIND_DEFAULTS = Object.freeze({
  /** Hard cap per block; past this the block is truncated with a marker. */
  maxChars: 2400,
  /** Max file paths listed individually before collapsing to a count. */
  maxFiles: 6,
  /** Max pheromone lines. */
  maxSignals: 8
})

function clip(text, max) {
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 24))}\n… [truncated]`
}

/** Wrap a body in the tag, escaping any accidental terminator. */
export function frame(body, tag = REMINDER_TAG) {
  const safe = escapeTagBody(body, tag)
  return `<${tag}>\n${safe}\n</${tag}>`
}

function listFiles(files, max) {
  if (files.length <= max) return files.join(', ')
  return `${files.slice(0, max).join(', ')} … +${files.length - max} more`
}

/**
 * Readiness block. `readiness` is `createLedger().readiness()`; `routes` are the
 * routes matched for the changed files.
 *
 * Returns an empty string when there is nothing actionable — a session that
 * changed nothing gets no reminder, which is the whole reason the block is
 * affordable.
 */
export function buildReadinessReminder(readiness, routes = [], options = {}) {
  const maxChars = options.maxChars ?? REMIND_DEFAULTS.maxChars
  const maxFiles = options.maxFiles ?? REMIND_DEFAULTS.maxFiles
  if (readiness === undefined || readiness === null) return ''
  const files = Array.isArray(readiness.files) ? readiness.files : []
  if (files.length === 0) return ''

  const unverified = files.filter((f) => f.status === 'unverified')
  const failed = files.filter((f) => f.status === 'failed')
  const blocked = files.filter((f) => f.status === 'blocked')

  if (unverified.length === 0 && failed.length === 0 && blocked.length === 0) return ''

  const lines = []
  if (failed.length > 0) {
    const commands = [...new Set(failed.map((f) => f.command).filter(Boolean))]
    lines.push(
      `VERIFICATION FAILED after the last write to ${listFiles(failed.map((f) => f.path), maxFiles)}` +
        (commands.length > 0 ? ` (${commands.map((c) => `\`${c}\``).join(', ')})` : '')
    )
    lines.push('Do not report this work as done. Fix the failure or report it as failing.')
  }
  if (unverified.length > 0) {
    lines.push(
      `${unverified.length} changed file(s) have no verification after their last write: ` +
        listFiles(unverified.map((f) => f.path), maxFiles)
    )
  }
  if (blocked.length > 0) {
    lines.push(
      `Verification could not run for ${listFiles(blocked.map((f) => f.path), maxFiles)} — ` +
        'report the block explicitly rather than claiming success.'
    )
  }

  if (Array.isArray(routes) && routes.length > 0) {
    lines.push('Declared checks for these paths (from .cairn/verify.json):')
    for (const route of routes.slice(0, REMIND_DEFAULTS.maxSignals)) {
      lines.push(`- \`${route.match}\` → \`${route.run}\``)
    }
  } else if (unverified.length > 0 || failed.length > 0) {
    lines.push(
      'This project declares no check for these paths. State what you ran, or that you ran nothing.'
    )
  }

  const body = clip(lines.join('\n'), maxChars)
  return frame(body)
}

/**
 * Pheromone block: what previous sessions learned about the files in play.
 * Only strong, live signals are rendered, and each is one line.
 */
export function buildPheromoneReminder(entries, options = {}) {
  const maxChars = options.maxChars ?? REMIND_DEFAULTS.maxChars
  const maxSignals = options.maxSignals ?? REMIND_DEFAULTS.maxSignals
  if (!Array.isArray(entries) || entries.length === 0) return ''
  const live = entries.filter((e) => Number(e.current) > 0)
  if (live.length === 0) return ''
  const lines = ['Prior sessions left signals on files in play (strength decays; verify before trusting):']
  for (const entry of live.slice(0, maxSignals)) {
    const strength = Math.round((Number(entry.current) || 0) * 100)
    const context = typeof entry.context === 'string' && entry.context.length > 0
      ? ` — ${entry.context}`
      : ''
    lines.push(`- ${entry.path} [${entry.signal} ${strength}%]${context}`)
  }
  if (live.length > maxSignals) lines.push(`- … ${live.length - maxSignals} more`)
  return frame(clip(lines.join('\n'), maxChars))
}

/**
 * One combined block for the pre-step injection path. Prefers readiness (which
 * is about the current turn) and appends at most a couple of pheromone lines,
 * because a step reminder competes with the actual task for attention.
 */
export function buildStepReminder({ readiness, routes, pheromones } = {}, options = {}) {
  const readinessBlock = buildReadinessReminder(readiness, routes, options)
  const pheromoneBlock = buildPheromoneReminder(pheromones, {
    ...options,
    maxSignals: Math.min(options.maxSignals ?? 4, 4)
  })
  if (readinessBlock === '' && pheromoneBlock === '') return ''
  if (readinessBlock === '') return pheromoneBlock
  if (pheromoneBlock === '') return readinessBlock
  // Merge the two bodies into one wrapper so the model sees a single notice.
  const inner = (block) => block.slice(block.indexOf('>') + 1, block.lastIndexOf('</'))
  // Each body carries its own trailing newline before the closing tag; without
  // trimming, the join leaves a double blank line in the middle of the notice.
  const merged = `${inner(readinessBlock).trimEnd()}\n\n${inner(pheromoneBlock).trim()}`.trim()
  return frame(clip(merged, options.maxChars ?? REMIND_DEFAULTS.maxChars))
}

/** Compact one-line status, used by the `cairn_status` tool header. */
export function formatReadinessLine(readiness) {
  if (readiness === undefined) return 'unknown'
  const files = Array.isArray(readiness.files) ? readiness.files : []
  // `attribute()` reports the verification's own status, so a covered file is
  // 'passed', not 'verified'. Counting the literal word 'verified' reported
  // "0 verified" for a fully verified session.
  const counts = { verified: 0, unverified: 0, failed: 0, blocked: 0 }
  for (const file of files) {
    const bucket = file.status === 'passed' ? 'verified' : file.status
    counts[bucket] = (counts[bucket] ?? 0) + 1
  }
  return (
    `${readiness.level} · ${files.length} file(s) changed · ` +
    `${counts.verified} verified · ${counts.unverified} unverified · ${counts.failed} failed` +
    (counts.blocked > 0 ? ` · ${counts.blocked} blocked` : '') +
    ` · ${formatCount(files.length)} tracked`
  )
}
