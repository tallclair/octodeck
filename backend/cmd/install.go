package cmd

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"text/template"

	"github.com/spf13/cobra"
)

const (
	serviceTemplate = `[Unit]
Description=OctoDeck Backend Daemon
After=network.target

[Service]
ExecStart={{.Executable}} serve
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=default.target
`
	serviceName = "octodeck.service"
)

type serviceData struct {
	Executable string
}

var installCmd = &cobra.Command{
	Use:   "install",
	Short: "Install the OctoDeck systemd service",
	Long:  `Generates and enables a user-level systemd service for OctoDeck.`,
	Args:  cobra.NoArgs,
	RunE: func(cmd *cobra.Command, _ []string) error {
		fmt.Println("Installing OctoDeck systemd service...")

		executable, err := os.Executable()
		if err != nil {
			return fmt.Errorf("failed to get executable path: %w", err)
		}

		serviceDir, err := getServiceDir()
		if err != nil {
			return fmt.Errorf("failed to get systemd user directory: %w", err)
		}

		if err := os.MkdirAll(serviceDir, 0750); err != nil {
			return fmt.Errorf("failed to create systemd user directory: %w", err)
		}

		servicePath := filepath.Join(serviceDir, serviceName)
		if err := writeServiceFile(servicePath, executable); err != nil {
			return fmt.Errorf("failed to write service file: %w", err)
		}

		if err := runSystemctl(cmd.Context(), "daemon-reload"); err != nil {
			return fmt.Errorf("failed to reload systemd: %w", err)
		}

		if err := runSystemctl(cmd.Context(), "enable", "--now", serviceName); err != nil {
			return fmt.Errorf("failed to enable systemd service: %w", err)
		}

		fmt.Printf("Successfully installed and started %s.\n", serviceName)
		fmt.Printf("To check the status, run: systemctl --user status %s\n", serviceName)
		fmt.Printf("To view logs, run: journalctl --user -u %s\n", serviceName)
		return nil
	},
}

func getServiceDir() (string, error) {
	configDir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(configDir, "systemd", "user"), nil
}

func writeServiceFile(path, executable string) (err error) {
	tmpl, err := template.New("service").Parse(serviceTemplate)
	if err != nil {
		return fmt.Errorf("failed to parse service template: %w", err)
	}

	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
	if err != nil {
		return fmt.Errorf("failed to open service file for writing: %w", err)
	}
	defer func() {
		if closeErr := file.Close(); closeErr != nil {
			err = errors.Join(err, closeErr)
		}
	}()

	return tmpl.Execute(file, serviceData{Executable: executable})
}

func runSystemctl(ctx context.Context, args ...string) error {
	allArgs := append([]string{"--user"}, args...)
	cmd := exec.CommandContext(ctx, "systemctl", allArgs...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func init() {
	rootCmd.AddCommand(installCmd)
}
