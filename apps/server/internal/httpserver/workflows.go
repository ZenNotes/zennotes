package httpserver

import (
	"net/http"
	"strings"

	"github.com/ZenNotes/zennotes/apps/server/internal/vault"
)

const (
	maxWorkflowRequestBytes         = 128 << 20
	maxWorkflowMetadataRequestBytes = 64 << 10
)

func (s *Server) listWorkflows(w http.ResponseWriter, _ *http.Request) {
	files, err := s.currentVault().ListWorkflows()
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, files)
}

func (s *Server) writeWorkflow(w http.ResponseWriter, r *http.Request) {
	cfg := s.currentConfig()
	r.Body = http.MaxBytesReader(w, r.Body, cfg.MaxNoteBytes+jsonEnvelopeBytes)
	var input vault.WriteWorkflowInput
	if err := readJSON(r, &input); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	file, err := s.currentVault().WriteWorkflow(input)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, file)
}

func (s *Server) deleteWorkflow(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxWorkflowMetadataRequestBytes)
	var request struct {
		SourcePath string `json:"sourcePath"`
	}
	if err := readJSON(r, &request); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := s.currentVault().DeleteWorkflow(request.SourcePath); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) applyWorkflow(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxWorkflowRequestBytes)
	var input vault.PreparedWorkflowRun
	if err := readJSON(r, &input); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	cfg := s.currentConfig()
	for _, change := range input.Changes {
		// Only what the run WRITES counts against the limit. Before is the
		// note's bytes already on disk: counting those made an oversized note
		// impossible to shrink, move, or trash from the web client, 413 on
		// every apply, while desktop applied the identical run.
		if cfg.MaxNoteBytes > 0 && change.After != nil && int64(len(*change.After)) > cfg.MaxNoteBytes {
			http.Error(w, "workflow note exceeds the configured note size limit", http.StatusRequestEntityTooLarge)
			return
		}
	}
	receipt, err := s.currentVault().ApplyPreparedWorkflow(input)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, receipt)
}

func (s *Server) undoWorkflowRun(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxWorkflowMetadataRequestBytes)
	var request struct {
		RunID string `json:"runId"`
	}
	if err := readJSON(r, &request); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	result, err := s.currentVault().UndoWorkflowRun(request.RunID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) listWorkflowRuns(w http.ResponseWriter, _ *http.Request) {
	runs, err := s.currentVault().ListWorkflowRuns()
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, runs)
}

func (s *Server) deleteWorkflowRuns(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxWorkflowMetadataRequestBytes)
	var request struct {
		WorkflowID string `json:"workflowId"`
	}
	if err := readJSON(r, &request); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	workflowID := strings.TrimSpace(request.WorkflowID)
	if workflowID == "" {
		http.Error(w, "workflowId is required", http.StatusBadRequest)
		return
	}
	removed, err := s.currentVault().DeleteWorkflowRuns(workflowID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, removed)
}
