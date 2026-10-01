// 必须最先加载：为模拟服务端补齐浏览器存储环境
const memory = new Map<string, string>()
;(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => (memory.has(k) ? memory.get(k)! : null),
  setItem: (k: string, v: string) => memory.set(k, String(v)),
  removeItem: (k: string) => memory.delete(k),
  clear: () => memory.clear(),
  key: (i: number) => Array.from(memory.keys())[i] ?? null,
  get length() { return memory.size },
}
const sessionMemory = new Map<string, string>()
;(globalThis as unknown as { sessionStorage: Storage }).sessionStorage = {
  getItem: (k: string) => (sessionMemory.has(k) ? sessionMemory.get(k)! : null),
  setItem: (k: string, v: string) => sessionMemory.set(k, String(v)),
  removeItem: (k: string) => sessionMemory.delete(k),
  clear: () => sessionMemory.clear(),
  key: (i: number) => Array.from(sessionMemory.keys())[i] ?? null,
  get length() { return sessionMemory.size },
}
;(globalThis as unknown as { window: unknown }).window = { addEventListener: () => {}, setInterval: () => 0 }
export {}
