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
  | 'bundled-external';

export type ExternalReason = DetectReason | { reachableFrom: string };

export interface Classification {
  external: Set<string>;
  reasons: Map<string, ExternalReason[]>;
}
