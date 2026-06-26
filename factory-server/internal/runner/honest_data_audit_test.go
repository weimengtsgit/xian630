package runner

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// writeAppFile writes content at the project-relative path under dir, creating
// intermediate dirs. Returns the project dir (dir) for convenience.
func writeAppFile(t *testing.T, dir, rel, content string) {
	t.Helper()
	full := filepath.Join(dir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", rel, err)
	}
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", rel, err)
	}
}

// TestAuditHonestDataSkipsNonRealPolicies proves the audit is a no-op for
// mock_data and unset policy: mock is explicitly allowed there, so even an app
// that ships a mock source file must pass.
func TestAuditHonestDataSkipsNonRealPolicies(t *testing.T) {
	dir := t.TempDir()
	writeAppFile(t, dir, "src/data/mock.js", "export const x = 1;\n")
	if err := AuditHonestData(dir, "mock_data", []string{"tide-data-skill"}); err != nil {
		t.Fatalf("mock_data audit = %v, want nil", err)
	}
	if err := AuditHonestData(dir, "", nil); err != nil {
		t.Fatalf("empty-policy audit = %v, want nil", err)
	}
}

// TestAuditHonestDataFlagsMockSourceFile proves a production mock source file
// (src/data/mock.js) under live_api is rejected.
func TestAuditHonestDataFlagsMockSourceFile(t *testing.T) {
	dir := t.TempDir()
	writeAppFile(t, dir, "src/data/mock.js", "export const ports = [1,2,3];\n")
	err := AuditHonestData(dir, "live_api", nil)
	if !errors.Is(err, ErrSchemaValidationFailed) {
		t.Fatalf("err = %v, want ErrSchemaValidationFailed for mock source file", err)
	}
}

// TestAuditHonestDataFlagsIsMockTrue proves the literal isMock:true is caught in
// any audited file.
func TestAuditHonestDataFlagsIsMockTrue(t *testing.T) {
	dir := t.TempDir()
	writeAppFile(t, dir, "src/data/tide.js", "export const state = { isMock: true, series: [] };\n")
	err := AuditHonestData(dir, "live_api", []string{"tide-data-skill"})
	if !errors.Is(err, ErrSchemaValidationFailed) {
		t.Fatalf("err = %v, want ErrSchemaValidationFailed for isMock:true", err)
	}
}

// TestAuditHonestDataFlagsMockIdentifier proves a mockData / MOCK_* identifier in
// a data-layer file under live_api is rejected even with no declared data skill.
func TestAuditHonestDataFlagsMockIdentifier(t *testing.T) {
	dir := t.TempDir()
	writeAppFile(t, dir, "src/data/tide.js", "const mockData = [{t:'x',v:0.1}];\nexport default mockData;\n")
	err := AuditHonestData(dir, "live_api", nil)
	if !errors.Is(err, ErrSchemaValidationFailed) {
		t.Fatalf("err = %v, want ErrSchemaValidationFailed for mockData identifier", err)
	}
}

// TestAuditHonestDataMathSinPasses proves Math.sin/cos in a data-layer file is
// NOT flagged: the numeric-synthesis rule was removed because it could not tell
// synthetic series apart from legitimate geometry/distance math (haversine,
// projections), which falsely blocked real data-science apps.
func TestAuditHonestDataMathSinPasses(t *testing.T) {
	dir := t.TempDir()
	writeAppFile(t, dir, "src/data/tide.js", "export function series(h){ return Math.sin(h/12*Math.PI); }\n")
	if err := AuditHonestData(dir, "live_api", []string{"tide-data-skill"}); err != nil {
		t.Fatalf("err = %v, want nil (Math.sin is not a reliable synthetic signal)", err)
	}
}

// TestAuditHonestDataMathRandomWithoutDataSkillPasses proves the Math rule is
// gated on a declared data skill: a live_api app with no data skill using
// Math.random in a data file is NOT flagged (avoids false positives where the
// numeric domain is unknown).
func TestAuditHonestDataMathRandomWithoutDataSkillPasses(t *testing.T) {
	dir := t.TempDir()
	writeAppFile(t, dir, "src/data/seq.js", "export const jitter = () => Math.random();\n")
	if err := AuditHonestData(dir, "live_api", nil); err != nil {
		t.Fatalf("err = %v, want nil (Math rule gated on data skill)", err)
	}
}

// TestAuditHonestDataUIRandomPasses proves the Math rule is scoped to data-layer
// files: a component using Math.random for a visual effect is not flagged even
// when a data skill is declared.
func TestAuditHonestDataUIRandomPasses(t *testing.T) {
	dir := t.TempDir()
	writeAppFile(t, dir, "src/components/Spark.jsx", "export const particles = () => Math.random();\n")
	if err := AuditHonestData(dir, "live_api", []string{"tide-data-skill"}); err != nil {
		t.Fatalf("err = %v, want nil (UI Math.random not data-layer)", err)
	}
}

// TestAuditHonestDataSkipsTestFiles proves test files are never flagged.
func TestAuditHonestDataSkipsTestFiles(t *testing.T) {
	dir := t.TempDir()
	writeAppFile(t, dir, "src/data/tide.test.js", "const mockData = [1];\ntest('x', () => {});\n")
	writeAppFile(t, dir, "src/data/__tests__/helper.spec.ts", "const isMock = true;\n")
	if err := AuditHonestData(dir, "live_api", []string{"tide-data-skill"}); err != nil {
		t.Fatalf("err = %v, want nil (test files skipped)", err)
	}
}

// TestAuditHonestDataSkipsNodeModulesAndDeps proves vendored/built artifacts are
// never scanned.
func TestAuditHonestDataSkipsNodeModulesAndDeps(t *testing.T) {
	dir := t.TempDir()
	writeAppFile(t, dir, "node_modules/lib/mock.js", "export const mockData = [1];\n")
	writeAppFile(t, dir, "dist/assets/mock.js", "const isMock = true;\n")
	if err := AuditHonestData(dir, "live_api", []string{"tide-data-skill"}); err != nil {
		t.Fatalf("err = %v, want nil (node_modules/dist skipped)", err)
	}
}

// TestAuditHonestDataCleanRealApp proves an honest real-data app (real fetch,
// no mock, no synthetic generators) passes.
func TestAuditHonestDataCleanRealApp(t *testing.T) {
	dir := t.TempDir()
	writeAppFile(t, dir, "src/data/tide.js", "export async function fetchTide(){ const r = await fetch(url); return r.json(); }\n")
	writeAppFile(t, dir, "src/components/Card.jsx", "export const Card = ({h}) => <div>{Math.round(h)}</div>;\n")
	if err := AuditHonestData(dir, "live_api", []string{"tide-data-skill", "deck-wind-data-skill"}); err != nil {
		t.Fatalf("err = %v, want nil for clean real-data app", err)
	}
}
