import { type NodeFileTraceResult, nodeFileTrace } from '@vercel/nft';

export function trace(files: string[], cwd: string): Promise<NodeFileTraceResult> {
  return nodeFileTrace(files, { base: cwd });
}
