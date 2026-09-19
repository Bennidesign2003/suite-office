import { fileURLToPath } from 'node:url'
import { analyzeMediaTool } from '@genoffice/ai-search'
import { flagString } from '../args'
import { aiSettingsPath, prepareCloud } from '../cloud'
import { resolveInput } from '../fs'
import type { CommandDef } from '../registry'
import { CliError, EXIT } from '../result'

const DEFAULT_ASK = 'Describe this image in detail: subject, text, layout, notable details.'

export const mediaCommand: CommandDef = {
  name: 'media',
  summary:
    'Describe or answer a question about an image (file or URL) with the configured local vision model.',
  usage: 'media <file|url> [--ask <question>]',
  options: [
    { name: 'ask', value: 'question', description: `what to extract (default: "${DEFAULT_ASK}")` },
  ],
  async run(args, ctx) {
    const ref = args.positionals[0]
    if (!ref)
      throw new CliError(EXIT.usage, 'missing <file|url>', undefined, {
        reason: 'missing_argument',
      })
    const target = /^https?:\/\//i.test(ref)
      ? ref
      : resolveInput(ref.startsWith('file:') ? fileURLToPath(ref) : ref, ctx)
    await prepareCloud(ctx.env)
    const r = await analyzeMediaTool(aiSettingsPath(ctx.env), {
      mediaUrls: [target],
      requirements: flagString(args, 'ask') ?? DEFAULT_ASK,
    })
    if (r.text === undefined) throw new CliError(EXIT.app, r.error ?? 'media analysis failed')
    return { summary: r.text, detail: { source: target, text: r.text } }
  },
}
