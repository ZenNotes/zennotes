// The resolver moved to shared-domain so the desktop main process can rewrite
// asset references with the exact rules the renderer resolves them by (#785).
// Re-exported here so the renderer's import sites stay put.
export * from '@shared/asset-path-resolution'
