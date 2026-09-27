// Handoff: the attach command for a session, as text, and nothing else (LD-FR-07,
// APX-CON-08, ADR-002, docs/IDEA.md#Boundaries).
//
// WHAT THIS IS
// A panel that shows one command and asks the developer to run it themselves.
//
// The whole of LD-FR-07 is "reveals the attach command ... so the developer can open
// it in their own terminal", and the whole of the boundary in docs/IDEA.md is
// "clicking a session hands off via `opencode attach` or the user's terminal. No
// write endpoints at all. Approving permissions from the page is deferred precisely
// because it would make an unauthenticated loopback service able to execute code on
// the user's behalf." This file is the second half of that sentence taken literally:
// the command is text, in a `<code>` element, in a document that has no `<form>`, no
// `<button>` and no event handler of any kind. Nothing here opens a terminal, starts
// a process, writes a file, opens a socket or reaches a harness - there is no
// function in this module that performs anything, which is the strongest form the
// absence of a control can take.
//
// WHY A ROW DOES NOT CARRY ITS OWN COPY OF THE COMMAND
// Ten rows would be ten identical-looking `<code>` elements in the accessibility
// tree, ten strings to keep in step with the row model, and a screen reader user
// arrowing through the list would hear a command after every row for no gain. The
// command is therefore revealed for the row the developer is on - the focused row,
// or the row they last activated - and the row that it is for is named in the
// panel's own text and in `data-handoff-session`, so nobody has to guess which row
// they are about to hand off.
//
// THE ONE CLAIM IN THIS FILE THAT CANNOT BE PROVEN HERE
// `opencode attach <session-id>` is this product's published form for a third-party
// CLI. The shape of `opencode attach`'s argument is a claim about opencode, not
// about agent-ping, and this repository cannot verify it. It is stated here as text
// for the developer to copy - which is the whole point of a handoff - and the table
// is an injected seam (`templates`) so correcting it is a one-line change rather
// than a redesign. LD-5's reviewer should confirm the form before it is treated as
// documentation. A harness agent-ping has no form for is never given a made-up one:
// the panel says it does not know one.

// ---------------------------------------------------------------------------
// The DOM contract
// ---------------------------------------------------------------------------

/** The panel itself. */
export const HANDOFF_REGION_ATTRIBUTE = 'data-dashboard-handoff'
/** The command, as the element a person selects and copies. */
export const HANDOFF_COMMAND_ATTRIBUTE = 'data-handoff-command'
/** The session the command is for. Absent when no row is on the page. */
export const HANDOFF_SESSION_ATTRIBUTE = 'data-handoff-session'
/** The harness the command is for, so an assertion can tell two templates apart. */
export const HANDOFF_HARNESS_ATTRIBUTE = 'data-handoff-harness'
/** The panel's own sentence: what it is, and what it is not. */
export const HANDOFF_INSTRUCTION_ATTRIBUTE = 'data-handoff-instruction'
/** The name of the list a screen reader announces the panel under. */
export const HANDOFF_LABEL = 'Attach this session in your own terminal'

/** What the panel says when no row is on the page, and when it knows no command. */
export const HANDOFF_NONE_SENTENCE = 'Focus a row to see the command that attaches to it.'
export const HANDOFF_NEVER_RUNS_SENTENCE =
  'This page shows the command. It cannot run it, and it has no control that would.'

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

/** One session's command, as the panel shows it. */
export interface HandoffCommand {
  readonly harness: string
  readonly sessionId: string
  /**
   * The command as text, or null when this product knows no attach command for the
   * harness. Null rather than an invented string: a command a developer pastes and
   * finds does not exist is worse than being told there is none.
   */
  readonly command: string | null
  /** What the panel prints about this row. */
  readonly sentence: string
}

/** The one thing a template is given: a session identifier. */
export type HandoffTemplate = (sessionId: string) => string

/**
 * The attach command per harness.
 *
 * `Record` over a `string` index rather than a closed union, because the harness
 * vocabulary is the hub's (`HubSession.harness`) and it is not this file's to close -
 * PRD 12 settles v1 on opencode, and a harness added later finds a missing key and a
 * sentence saying so rather than an `undefined` rendered as text.
 */
export const HARNESS_ATTACH: Readonly<Record<string, HandoffTemplate>> = Object.freeze({
  opencode: (sessionId: string): string => `opencode attach ${sessionId}`,
})

/** The sentence for a harness this product has no attach command for. */
export function unknownHarnessSentence(harness: string): string {
  return (
    `agent-ping does not know an attach command for ${harness}, so it will not invent one. ` +
    'Open that session in your own terminal.'
  )
}

/**
 * The command for one session.
 *
 * A function rather than a lookup so the templates can be replaced wholesale, which
 * is what correcting a third-party CLI's argument shape should cost.
 */
export function handoffCommand(
  session: { readonly harness: string; readonly sessionId: string },
  templates: Readonly<Record<string, HandoffTemplate>> = HARNESS_ATTACH,
): HandoffCommand {
  const template = templates[session.harness]
  if (template === undefined) {
    return {
      harness: session.harness,
      sessionId: session.sessionId,
      command: null,
      sentence: unknownHarnessSentence(session.harness),
    }
  }
  return {
    harness: session.harness,
    sessionId: session.sessionId,
    command: template(session.sessionId),
    sentence: `${HANDOFF_NEVER_RUNS_SENTENCE} Copy it into a terminal.`,
  }
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

export interface CreateHandoffPanelOptions {
  /** Where the panel is mounted. Normally the same container as the canvas. */
  readonly parent: HTMLElement
  /** Defaults to the document the parent belongs to. */
  readonly document?: Document
  /** Replaces the built-in command table. See `HandoffTemplate`. */
  readonly templates?: Readonly<Record<string, HandoffTemplate>>
}

export interface HandoffPanel {
  readonly root: HTMLElement
  /** Reveal the command for one session, or clear the panel with null. */
  reveal(session: { readonly harness: string; readonly sessionId: string } | null): void
  /** The command currently revealed, or null. */
  readonly command: HandoffCommand | null
  readonly isDestroyed: boolean
  destroy(): void
}

export function createHandoffPanel(options: CreateHandoffPanelOptions): HandoffPanel {
  const doc = options.document ?? options.parent.ownerDocument
  const templates = options.templates ?? HARNESS_ATTACH

  const root = doc.createElement('section')
  root.setAttribute(HANDOFF_REGION_ATTRIBUTE, '')
  root.setAttribute('aria-label', HANDOFF_LABEL)

  const instruction = doc.createElement('p')
  instruction.setAttribute(HANDOFF_INSTRUCTION_ATTRIBUTE, '')
  instruction.textContent = HANDOFF_NONE_SENTENCE
  root.append(instruction)

  // A `<code>` element, never an input, a button or a form control: the text has to
  // be selectable and copyable, and it has to be impossible to submit, press or fire.
  const command = doc.createElement('code')
  command.setAttribute(HANDOFF_COMMAND_ATTRIBUTE, '')
  command.textContent = ''
  root.append(command)

  options.parent.append(root)

  let current: HandoffCommand | null = null
  let destroyed = false

  return {
    root,
    reveal(session): void {
      if (destroyed) return
      if (session === null) {
        current = null
        root.removeAttribute(HANDOFF_SESSION_ATTRIBUTE)
        root.removeAttribute(HANDOFF_HARNESS_ATTRIBUTE)
        command.textContent = ''
        instruction.textContent = HANDOFF_NONE_SENTENCE
        return
      }
      const next = handoffCommand(session, templates)
      current = next
      root.setAttribute(HANDOFF_SESSION_ATTRIBUTE, next.sessionId)
      root.setAttribute(HANDOFF_HARNESS_ATTRIBUTE, next.harness)
      command.textContent = next.command ?? ''
      instruction.textContent = next.sentence
    },
    get command(): HandoffCommand | null {
      return current
    },
    get isDestroyed(): boolean {
      return destroyed
    },
    destroy(): void {
      if (destroyed) return
      destroyed = true
      current = null
      root.remove()
    },
  }
}
