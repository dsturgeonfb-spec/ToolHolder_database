/**
 * Background jobs for slow work (vendor scans at a 10 s crawl delay, image downloads).
 * In memory only: a job's *result* is a proposal the user approves; nothing is written
 * to the database by a job until an approve endpoint applies it.
 */
export type JobStatus = 'running' | 'done' | 'failed' | 'cancelled'

export interface JobState {
  id: string
  kind: string
  title: string
  status: JobStatus
  done: number
  total: number
  message: string
  log: string[]
  result?: unknown
  error?: string
  started_at: string
  finished_at?: string
}

export interface JobApi {
  readonly id: string
  readonly signal: AbortSignal
  progress(done: number, total: number, message?: string): void
  log(message: string): void
  /** Resolves after `ms`, or rejects early if the job is cancelled. */
  sleep(ms: number): Promise<void>
}

const MAX_LOG = 500
const KEEP_FINISHED = 50

export class Jobs {
  private jobs = new Map<string, { state: JobState; ctrl: AbortController }>()
  private seq = 0

  start(kind: string, title: string, fn: (api: JobApi) => Promise<unknown>): JobState {
    const id = `job-${Date.now().toString(36)}-${(++this.seq).toString(36)}`
    const ctrl = new AbortController()
    const state: JobState = { id, kind, title, status: 'running', done: 0, total: 0, message: '', log: [], started_at: new Date().toISOString() }
    this.jobs.set(id, { state, ctrl })
    const api: JobApi = {
      id,
      signal: ctrl.signal,
      progress: (done, total, message) => {
        state.done = done
        state.total = total
        if (message !== undefined) state.message = message
      },
      log: (message) => {
        state.log.push(`${new Date().toLocaleTimeString('en-GB')}  ${message}`)
        if (state.log.length > MAX_LOG) state.log.splice(0, state.log.length - MAX_LOG)
      },
      sleep: (ms) =>
        new Promise<void>((resolve, reject) => {
          if (ctrl.signal.aborted) return reject(new Error('Cancelled'))
          const t = setTimeout(resolve, ms)
          ctrl.signal.addEventListener('abort', () => (clearTimeout(t), reject(new Error('Cancelled'))), { once: true })
        }),
    }
    void Promise.resolve()
      .then(() => fn(api))
      .then(
        (result) => {
          if (state.status === 'running') state.status = 'done'
          state.result = result
        },
        (err: unknown) => {
          if (ctrl.signal.aborted) state.status = 'cancelled'
          else {
            state.status = 'failed'
            state.error = err instanceof Error ? err.message : String(err)
          }
        },
      )
      .finally(() => {
        state.finished_at = new Date().toISOString()
        this.prune()
      })
    return state
  }

  get(id: string): JobState | undefined {
    return this.jobs.get(id)?.state
  }

  cancel(id: string): JobState | undefined {
    const j = this.jobs.get(id)
    if (!j) return undefined
    if (j.state.status === 'running') {
      j.ctrl.abort()
      j.state.status = 'cancelled'
    }
    return j.state
  }

  list(): JobState[] {
    return [...this.jobs.values()].map((j) => j.state).reverse()
  }

  /** Waits for a job to finish (tests, CLI). */
  async wait(id: string, timeoutMs = 120_000): Promise<JobState> {
    const t0 = Date.now()
    for (;;) {
      const s = this.get(id)
      if (!s) throw new Error(`No job ${id}`)
      if (s.status !== 'running' && s.finished_at) return s
      if (Date.now() - t0 > timeoutMs) throw new Error(`Job ${id} timed out`)
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  cancelAll(): void {
    for (const j of this.jobs.values()) if (j.state.status === 'running') j.ctrl.abort()
  }

  private prune(): void {
    const finished = [...this.jobs.values()].filter((j) => j.state.status !== 'running')
    for (const j of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) this.jobs.delete(j.state.id)
  }
}
