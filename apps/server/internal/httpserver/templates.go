package httpserver

import (
	"net/http"

	"github.com/ZenNotes/zennotes/apps/server/internal/vault"
)

func (s *Server) listTemplates(w http.ResponseWriter, _ *http.Request) {
	files, err := s.currentVault().ListTemplates()
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, files)
}

func (s *Server) readTemplate(w http.ResponseWriter, r *http.Request) {
	raw, err := s.currentVault().ReadTemplate(r.URL.Query().Get("path"))
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"raw": raw})
}

func (s *Server) writeTemplate(w http.ResponseWriter, r *http.Request) {
	cfg := s.currentConfig()
	r.Body = http.MaxBytesReader(w, r.Body, cfg.MaxNoteBytes+jsonEnvelopeBytes)
	var input vault.WriteTemplateInput
	if err := readJSON(r, &input); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if cfg.MaxNoteBytes > 0 && int64(len(input.Raw)) > cfg.MaxNoteBytes {
		http.Error(w, "template exceeds the configured note size limit", http.StatusRequestEntityTooLarge)
		return
	}
	file, err := s.currentVault().WriteTemplate(input)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, file)
}

func (s *Server) deleteTemplate(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, jsonEnvelopeBytes)
	var request struct {
		SourcePath string `json:"sourcePath"`
	}
	if err := readJSON(r, &request); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := s.currentVault().DeleteTemplate(request.SourcePath); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
