/** Bound both the headers and response-body phases, including servers that stop sending. */
export async function boundedFetch(url: string, options: RequestInit = {}, timeoutMs = 15_000): Promise<Response> {
  const controller = new AbortController()
  async function bounded<T>(work: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([work(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('Network request timed out. Please retry.')) }, timeoutMs)
      })])
    } finally { if (timer) clearTimeout(timer) }
  }
  const response = await bounded(() => fetch(url, { ...options, signal: controller.signal }))
  return new Proxy(response, {
    get(target, key) {
      if (key === 'json' || key === 'text' || key === 'arrayBuffer') return () => bounded(() => target[key]())
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
