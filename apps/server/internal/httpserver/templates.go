package httpserver

import (
	"errors"
	"net/http"

	"github.com/ZenNotes/zennotes/apps/server/internal/vault"
)

// Custom-template routes: the server half of Settings, Templates for the web
// client and for a desktop connected to a remote vault. Clients gate on the
// supportsCustomTemplates capability, so an older server answers a bare 404
// here and they say the server needs an update instead.

const maxTemplateMetadataRequestBytes = 64 << 10

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
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			http.Error(w, "template exceeds the configured note size limit", http.StatusRequestEntityTooLarge)
			return
		}
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	// The envelope allowance above is for field names and JSON escaping, not
	// for the template: a body that fits the reader can still unescape to a
	// raw string past the note limit, and a template is a note in waiting.
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
	r.Body = http.MaxBytesReader(w, r.Body, maxTemplateMetadataRequestBytes)
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
