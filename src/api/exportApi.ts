import axios, { type AxiosAdapter } from 'axios'
import type { ExportTask } from '../stores/imposition'
import { useImpositionStore } from '../stores/imposition'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const adapter: AxiosAdapter = async (config) => {
  await sleep(160)
  const store = useImpositionStore()
  if (config.url === '/api/print/export-tasks' && config.method === 'get') {
    return { data: structuredClone(store.tasks), status: 200, statusText: 'OK', headers: {}, config }
  }
  const resumeMatch = config.url?.match(/^\/api\/print\/export-tasks\/([^/]+)\/resume$/)
  if (resumeMatch && config.method === 'post') {
    const id = resumeMatch[1]
    const result = store.resumeTask(id)
    return { data: structuredClone(result), status: 200, statusText: 'OK', headers: {}, config }
  }
  return { data: null, status: 404, statusText: 'Not Found', headers: {}, config }
}

const client = axios.create({ adapter })

export const exportApi = {
  list: () => client.get<ExportTask[]>('/api/print/export-tasks'),
  resume: (id: string) => client.post<{ ok: boolean; error?: string }>(`/api/print/export-tasks/${id}/resume`),
}
