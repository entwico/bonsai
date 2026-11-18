export type DetectReason =
  | 'native-bindings'
  | 'nft-warning'
  | 'ast-worker'
  | 'ast-fork'
  | 'ast-eval'
  | 'ast-dyn-require'
  | 'ast-dyn-import'
  | 'ast-module-register'
  | 'ast-loader-patch'
  | 'ast-import-meta-resolve'
  | 'bundled-external'
  | 'unresolved-import';

export type ExternalReason = DetectReason | { reachableFrom: string };

export interface Classification {
  /** packages with codepaths the trace cannot follow: never inlined, kept whole by the prune */
  external: Set<string>;
  /** packages an external package imports: never inlined, pruned to their traced files */
  shared: Set<string>;
  reasons: Map<string, ExternalReason[]>;
}
