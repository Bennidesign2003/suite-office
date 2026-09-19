import type { AgentSkill } from '@genoffice/agent-core'
import { t } from '../i18n/locale'

/**
 * Image acquisition AgentSkill: image_search over the shared main-process
 * channel (same source as docs/slides). It returns a URL; placement happens
 * through the normal propose_operations add_image path, which downloads the
 * URL in the main process on apply.
 *
 * There is no generate_image companion: Ollama serves no image-output
 * endpoint, so the model is told to find a real image rather than offered a
 * tool that cannot work.
 */

const PLACEMENT_PROMPT = `- To place an image on a sheet, pass the URL to propose_operations {op:"add_image", sheetId, path:"<https url>", anchorCell} — field details in guide charts. The image anchors at that cell and is written into the file on save (imported xlsx only).
- Only insert images the user asked for; data correctness always outranks decoration.`

const IMAGES_SYSTEM_PROMPT = `## Images
- image_search finds real web images (returns direct imageUrl entries). Images cannot be generated here — find a real one or leave the spot empty.
${PLACEMENT_PROMPT}`

export function createImageSkill(): AgentSkill {
  const tools = [
    {
      name: 'image_search',
      description:
        'Search the web for images. Returns a numbered list of direct imageUrl entries with pixel sizes; ' +
        'pick one and insert it with propose_operations add_image (path = the URL).',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Image search keywords (English works better)' },
          maxResults: { type: 'integer', description: 'Maximum number of results, default 8' },
        },
        required: ['query'],
      },
    },
  ]
  return {
    id: 'images',
    systemPrompt: IMAGES_SYSTEM_PROMPT,
    tools,
    executeTool: async (call) => {
      if (call.name === 'image_search') {
        const query = String(call.input.query ?? '').trim()
        if (!query) {
          return {
            output: 'query must not be empty',
            isError: true,
            summary: t('aiToolImageSearch'),
          }
        }
        const result = await window.desktopApi.imageSearch(
          query,
          Number(call.input.maxResults) || 8,
        )
        // A backend failure must not read as an empty gallery — the model
        // would fabricate image choices
        if (result.method === 'error') {
          return {
            output: `image search failed (service error, not an empty result — you may retry): ${result.error ?? 'unknown error'}`,
            isError: true,
            summary: t('aiToolImageSearch'),
          }
        }
        const lines = result.images.map(
          (image, index) =>
            `${index + 1}. ${image.title || '(untitled)'} [${image.width ?? '?'}x${image.height ?? '?'}]\n   ${image.imageUrl}`,
        )
        return {
          output: lines.join('\n') || '(no images)',
          mutated: false,
          summary: t('aiToolImageSearchDone', { query, count: result.images.length }),
        }
      }
      return { output: `Unknown tool: ${call.name}`, isError: true, summary: call.name }
    },
  }
}
