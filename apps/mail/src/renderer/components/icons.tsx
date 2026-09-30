import type { ReactElement, ReactNode } from 'react'

function Svg({ children, size = 18 }: { children: ReactNode; size?: number }): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  )
}

export const IconCompose = () => (
  <Svg>
    <path d="M11.5 3.5h-6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-6" />
    <path d="M14.5 2.8a1.4 1.4 0 0 1 2 2L10 11.3l-2.7.7.7-2.7z" />
  </Svg>
)
export const IconReply = () => (
  <Svg>
    <path d="M8 5 3.5 9.5 8 14" />
    <path d="M3.5 9.5h8a5 5 0 0 1 5 5v1" />
  </Svg>
)
export const IconReplyAll = () => (
  <Svg>
    <path d="M9 5 4.5 9.5 9 14" />
    <path d="M5.5 5 1 9.5 5.5 14" />
    <path d="M4.5 9.5h7.5a5 5 0 0 1 5 5v1" />
  </Svg>
)
export const IconForward = () => (
  <Svg>
    <path d="M12 5l4.5 4.5L12 14" />
    <path d="M16.5 9.5h-8a5 5 0 0 0-5 5v1" />
  </Svg>
)
export const IconTrash = () => (
  <Svg>
    <path d="M3.5 5.5h13M8 5.5V4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5" />
    <path d="M5 5.5l.8 10a1.5 1.5 0 0 0 1.5 1.4h5.4a1.5 1.5 0 0 0 1.5-1.4l.8-10" />
  </Svg>
)
export const IconFolderMove = () => (
  <Svg>
    <path d="M2.5 6V5a1.5 1.5 0 0 1 1.5-1.5h3.5l2 2h6.5A1.5 1.5 0 0 1 17.5 7v7.5A1.5 1.5 0 0 1 16 16H4a1.5 1.5 0 0 1-1.5-1.5V9" />
    <path d="M1.5 12.5h7M6.5 10l2.5 2.5L6.5 15" />
  </Svg>
)
export const IconEnvelopeOpen = () => (
  <Svg>
    <path d="M2.5 8 10 3l7.5 5v7.5a1.5 1.5 0 0 1-1.5 1.5H4a1.5 1.5 0 0 1-1.5-1.5z" />
    <path d="M2.5 8 10 12.5 17.5 8" />
  </Svg>
)
export const IconEnvelope = () => (
  <Svg>
    <rect x="2.5" y="4.5" width="15" height="11" rx="1.5" />
    <path d="m3 5.5 7 5.5 7-5.5" />
  </Svg>
)
export const IconFlag = () => (
  <Svg>
    <path d="M4.5 17.5v-14M4.5 4h9.5l-2 3.5 2 3.5H4.5" />
  </Svg>
)
export const IconRefresh = () => (
  <Svg>
    <path d="M16.5 10a6.5 6.5 0 1 1-2-4.7" />
    <path d="M16.5 3.5v3.5H13" />
  </Svg>
)
export const IconSearch = () => (
  <Svg size={16}>
    <circle cx="8.5" cy="8.5" r="5" />
    <path d="m12.5 12.5 4 4" />
  </Svg>
)
export const IconPaperclip = () => (
  <Svg size={16}>
    <path d="m15.5 9.5-5.8 5.8a3.5 3.5 0 0 1-5-5l6.4-6.4a2.3 2.3 0 0 1 3.3 3.3l-6.2 6.2a1.2 1.2 0 0 1-1.7-1.7l5.6-5.6" />
  </Svg>
)
export const IconSend = () => (
  <Svg>
    <path d="M17.5 2.5 9 11M17.5 2.5l-5 15-3.5-6.5-6.5-3.5z" />
  </Svg>
)
export const IconPlus = () => (
  <Svg size={16}>
    <path d="M10 4v12M4 10h12" />
  </Svg>
)
export const IconGear = () => (
  <Svg size={15}>
    <circle cx="10" cy="10" r="2.5" />
    <path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" />
  </Svg>
)
export const IconChevron = ({ open }: { open: boolean }) => (
  <Svg size={14}>
    <path d={open ? 'm5 8 5 5 5-5' : 'm8 5 5 5-5 5'} />
  </Svg>
)
export const IconClose = () => (
  <Svg size={16}>
    <path d="m5 5 10 10M15 5 5 15" />
  </Svg>
)

const FOLDER_PATHS: Record<string, ReactNode> = {
  '\\Inbox': (
    <path d="M2.5 11h4l1.5 2h4l1.5-2h4M4.5 4.5h11l2 6.5v4a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 15v-4z" />
  ),
  '\\Sent': <path d="M17.5 2.5 9 11M17.5 2.5l-5 15-3.5-6.5-6.5-3.5z" />,
  '\\Drafts': <path d="M12 3.5 16.5 8 8 16.5H3.5V12zM10.5 5l4.5 4.5" />,
  '\\Trash': (
    <path d="M3.5 5.5h13M8 5.5V4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5M5 5.5l.8 10a1.5 1.5 0 0 0 1.5 1.4h5.4a1.5 1.5 0 0 0 1.5-1.4l.8-10" />
  ),
  '\\Junk': <path d="M10 2.5 17.5 16h-15zM10 8v3.5M10 13.8v.2" />,
  '\\Archive': <path d="M2.5 4h15v3.5h-15zM4 7.5v8a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-8M8 10.5h4" />,
}

export function FolderIcon({ use }: { use?: string }): ReactElement {
  return (
    <Svg size={16}>
      {(use && FOLDER_PATHS[use]) || (
        <path d="M2.5 5.5A1.5 1.5 0 0 1 4 4h3.5l2 2H16a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 16 16H4a1.5 1.5 0 0 1-1.5-1.5z" />
      )}
    </Svg>
  )
}

/** Suite brand mark: rounded square with the S cut out */
export function SuiteMark({ size = 18 }: { size?: number }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 130 130.025" aria-hidden>
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M24.64 0H105.12C118.72 0 129.76 11.04 129.76 24.64V105.38C129.76 118.98 118.72 130.03 105.12 130.03H24.64C11.04 130.03 0 118.98 0 105.38V24.64C0 11.04 11.04 0 24.64 0ZM70.64 53.18L69.18 53.36L68.27 53.91L67.54 55.91L67.54 73.54L67.00 76.09L65.54 78.82L62.82 81.54L48.27 89.73L46.82 91.00L46.27 92.46L46.82 94.27L47.91 95.36L62.64 103.91L65.36 104.82L69.73 104.82L71.91 104.09L87.18 95.36L90.09 92.09L91.54 88.09L91.54 69.18L90.09 65.54L88.64 63.54L87.18 62.27L71.73 53.36ZM64.46 25.00L60.09 25.00L57.91 25.73L42.64 34.46L39.73 37.73L38.27 41.73L38.27 60.46L39.00 63.00L41.73 66.82L45.00 69.00L45.91 69.18L55.91 75.00L56.64 75.73L59.36 76.64L60.82 76.46L61.91 75.36L62.27 74.09L62.27 55.91L63.54 52.09L66.27 48.82L81.54 40.09L83.00 38.82L83.54 37.54L83.54 36.64L83.00 35.54L81.91 34.46L67.18 25.91Z"
      />
    </svg>
  )
}
