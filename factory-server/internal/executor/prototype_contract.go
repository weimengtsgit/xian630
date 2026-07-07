package executor

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
	"github.com/weimengtsgit/xian630/factory-server/internal/runner"
)

type prototypeBundle struct {
	Manifest        model.PrototypeManifest
	Contract        model.PrototypeContract
	PreviewRelPath  string
	ContractRelPath string
	IndexRelPath    string
}

func readPrototypeBundle(ws runner.AttemptWorkspace) (prototypeBundle, error) {
	protoDir := filepath.Join(ws.Dir(), "prototype")
	manifestPath := filepath.Join(protoDir, "preview-manifest.json")
	contractPath := filepath.Join(protoDir, "prototype-contract.json")
	indexPath := filepath.Join(protoDir, "index.html")
	if _, err := os.Stat(indexPath); err != nil {
		return prototypeBundle{}, fmt.Errorf("prototype index.html required: %w", err)
	}
	var manifest model.PrototypeManifest
	if err := readJSONFile(manifestPath, &manifest); err != nil {
		return prototypeBundle{}, err
	}
	var contract model.PrototypeContract
	if err := readJSONFile(contractPath, &contract); err != nil {
		return prototypeBundle{}, err
	}
	if len(manifest.Pages) == 0 {
		return prototypeBundle{}, fmt.Errorf("prototype manifest home page required")
	}
	for _, page := range manifest.Pages {
		if page.Generated && !safePrototypeFile(page.File) {
			return prototypeBundle{}, fmt.Errorf("unsafe prototype page file %q", page.File)
		}
	}
	baseRel := filepath.ToSlash(filepath.Join("jobs", ws.JobID, string(ws.StepKind), fmt.Sprintf("attempt-%d", ws.Attempt), "prototype"))
	return prototypeBundle{
		Manifest:        manifest,
		Contract:        contract,
		PreviewRelPath:  baseRel + "/preview-manifest.json",
		ContractRelPath: baseRel + "/prototype-contract.json",
		IndexRelPath:    baseRel + "/index.html",
	}, nil
}

func readJSONFile(path string, out any) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("decode %s: %w", path, err)
	}
	return nil
}

func safePrototypeFile(path string) bool {
	clean := filepath.ToSlash(filepath.Clean(path))
	return strings.HasPrefix(clean, "prototype/") && !strings.Contains(clean, "../") && !filepath.IsAbs(clean)
}
