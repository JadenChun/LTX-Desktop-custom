import { handle } from './typed-handle'
import {
  deleteMcpProject,
  getMcpProject,
  listMcpProjects,
  putMcpProject,
} from '../mcp-project-store'

export function registerMcpProjectHandlers(): void {
  handle('listMcpProjects', () => {
    return listMcpProjects()
  })

  handle('getMcpProject', ({ projectId }) => {
    return getMcpProject(projectId)
  })

  handle('putMcpProject', ({ projectId, project, ifMatch }) => {
    return putMcpProject(projectId, project, ifMatch)
  })

  handle('deleteMcpProject', ({ projectId }) => {
    return deleteMcpProject(projectId)
  })
}
