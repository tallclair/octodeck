package cmd

import (
	"os"

	"github.com/spf13/cobra"
)

var configPath string

var rootCmd = &cobra.Command{
	Use:   "octodeck",
	Short: "OctoDeck Backend Daemon",
	Long:  `OctoDeck is a locally hosted dashboard for high-volume Kubernetes maintainers.`,
}

// Execute adds all child commands to the root command and sets flags appropriately.
// This is called by main.main(). It only needs to happen once to the rootCmd.
func Execute() {
	err := rootCmd.Execute()
	if err != nil {
		os.Exit(1)
	}
}

func init() {
	rootCmd.PersistentFlags().StringVar(&configPath, "config", "",
		"Path to config file (default ~/.octodeck/config.json)")
}
