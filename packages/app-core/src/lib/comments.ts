/**
 * The comment anchor helpers moved to shared-domain (#738) so the MCP server
 * and the CLI resolve anchors exactly as the editor does. Re-exported here
 * for the two components that import them.
 */
export {
  commentQuote,
  resolveCommentAnchor,
  selectionToCommentAnchor,
  type ResolvedCommentAnchor
} from '@shared/note-comments'
