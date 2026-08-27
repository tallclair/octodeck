package main

import (
	"embed"
)

// FrontendFS embeds the compiled Web App static files directly into the Go binary.
//
//go:embed frontend_dist
var FrontendFS embed.FS
