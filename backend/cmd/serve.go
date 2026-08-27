package cmd

import (
	"fmt"
	"io/fs"
	"os"
	"os/signal"
	"syscall"

	"github.com/spf13/cobra"

	"github.com/tallclair/octodeck/backend/internal/config"
	"github.com/tallclair/octodeck/backend/internal/database"
	"github.com/tallclair/octodeck/backend/internal/github"
	"github.com/tallclair/octodeck/backend/internal/logger"
	"github.com/tallclair/octodeck/backend/internal/logic"
	"github.com/tallclair/octodeck/backend/internal/server"
)

var (
	port       int
	dbPath     string
	logLevel   string
	logFormat  string
	devServer  string
	frontendFS fs.FS
)

// SetFrontendFS sets the embedded filesystem for serving the web app.
func SetFrontendFS(fsys fs.FS) {
	frontendFS = fsys
}

var serveCmd = &cobra.Command{
	Use:   "serve",
	Short: "Start the OctoDeck server",
	Args:  cobra.NoArgs,
	RunE:  runServe,
}

func runServe(cmd *cobra.Command, _ []string) error {
	logger.Init(logger.ParseLevel(logLevel), logFormat)

	overrides := config.Overrides{
		DBPath:    dbPath,
		DevServer: devServer,
	}
	cfg, err := config.Load(configPath, overrides)
	if err != nil {
		return fmt.Errorf("failed to load config: %w", err)
	}

	dbPathStr, err := cfg.GetDBPath()
	if err != nil {
		return fmt.Errorf("could not determine database path: %w", err)
	}
	db, err := database.Init(cmd.Context(), dbPathStr)
	if err != nil {
		return fmt.Errorf("failed to initialize database: %w", err)
	}
	defer db.Close()

	ghClient, err := github.NewClient()
	if err != nil {
		return fmt.Errorf("failed to create GitHub client: %w", err)
	}

	syncEngine := logic.NewSyncEngine(db, ghClient, cfg)
	srv := server.New(db, ghClient, syncEngine, cfg, frontendFS)

	ctx, stop := signal.NotifyContext(cmd.Context(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	syncEngine.Start(ctx)
	defer syncEngine.Stop()

	return srv.Start(ctx, port)
}

func init() {
	serveCmd.Flags().IntVarP(&port, "port", "p", config.DefaultPort, "Port to listen on")
	serveCmd.Flags().StringVar(&dbPath, "db-path", "", "Path to SQLite database (default ~/.octodeck/octodeck.db)")
	serveCmd.Flags().StringVar(&logLevel, "log-level", "info", "Log level (debug, info, warn, error)")
	serveCmd.Flags().StringVar(&logFormat, "log-format", "json", "Log format (json, text)")
	serveCmd.Flags().StringVar(
		&devServer,
		"debug-server",
		"",
		"Proxy frontend requests to this Vite dev server (default http://localhost:5173 if specified without a URL)",
	)
	serveCmd.Flags().Lookup("debug-server").NoOptDefVal = config.DefaultDevServer
	rootCmd.AddCommand(serveCmd)
}
