package runner

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// AuditHonestData scans a generated app's project directory for mock /
// synthetic-data indicators that violate the honest-data contract. It applies
// ONLY when dataPolicy is a real-data policy (live_api or mock_then_api); for
// mock_data or an unset policy it is a no-op, because mock is explicitly allowed
// there and must not be penalized.
//
// dataSkills is the confirmed requirement's generationProfile.data skill list.
// It is currently accepted but UNUSED: an earlier "Math.sin/cos/random in a
// data-layer file" rule was removed because it could not distinguish synthetic
// series generation from legitimate geometry/distance calculations (haversine,
// map projections, sampling), which falsely blocked real data-science apps. The
// parameter stays in the signature for call-site stability.
//
// The rules are deliberately CONSERVATIVE and high-precision: they target
// explicit mock tells (mock source filenames, isMock:true, mock data providers,
// MOCK_/mockData identifiers and synthetic-generator comments in data-layer
// files). Test files, vendored dependencies, and build output are never scanned,
// so legitimate test mocks and third-party code cannot trip the audit. A hit
// returns ErrSchemaValidationFailed (wrapped) naming the offending file(s) and
// reason(s); finishCodeGeneration maps that onto a failed code_generation step.
func AuditHonestData(projectDir, dataPolicy string, dataSkills []string) error {
	if dataPolicy != "live_api" && dataPolicy != "mock_then_api" {
		return nil
	}

	var findings []string
	add := func(rel, reason string) {
		findings = append(findings, fmt.Sprintf("%s — %s", rel, reason))
	}

	_ = filepath.WalkDir(projectDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if auditSkipSegment(d.Name()) {
				return filepath.SkipDir
			}
			return nil
		}
		rel, rerr := filepath.Rel(projectDir, path)
		if rerr != nil {
			return nil
		}
		relSlash := filepath.ToSlash(rel)
		if auditSkipFile(relSlash, d.Name()) {
			return nil
		}
		ext := strings.ToLower(filepath.Ext(d.Name()))
		if !auditedExts[ext] {
			return nil
		}

		stem := strings.ToLower(strings.TrimSuffix(d.Name(), ext))
		// Rule A: a production mock source file under src/ (mock.js / mockData.js /
		// mock-data.js / mocks.js / mock_data.js). High precision: the regex binds
		// the whole stem, so MockButton.jsx is NOT matched.
		if strings.HasPrefix(relSlash, "src/") && mockSourceStemRe.MatchString(stem) {
			add(relSlash, "生产 mock 数据文件（mock / mockData 等命名）")
		}

		raw, rerr := os.ReadFile(path)
		if rerr != nil || len(raw) > honestDataMaxFileBytes {
			return nil
		}
		body := string(raw)

		// Rule B: isMock:true marker — any audited file.
		if isMockTrueRe.MatchString(body) {
			add(relSlash, "包含 isMock: true 标记")
		}
		// Rule C: "mock data provider" literal — any audited file.
		if mockProviderRe.MatchString(body) {
			add(relSlash, "包含 mock data provider 字样")
		}

		// Rule D is scoped to data-layer files to avoid UI noise.
		if isDataLayerFile(relSlash) {
			if loc := mockIdentRe.FindString(body); loc != "" {
				add(relSlash, "数据层出现合成/mock 标识符: "+loc)
			}
			if syntheticCommentRe.MatchString(body) {
				add(relSlash, "数据层出现合成数据生成器注释（假数据/演示数据/合成数据/模拟数据/mock data/synthetic）")
			}
		}
		return nil
	})

	if len(findings) == 0 {
		return nil
	}
	shown := findings
	if len(shown) > honestDataMaxFindings {
		shown = shown[:honestDataMaxFindings]
		extra := len(findings) - honestDataMaxFindings
		shown = append(shown, fmt.Sprintf("…另有 %d 处迹象未列出", extra))
	}
	return fmt.Errorf("%w: 真实数据模式（%s）下检测到 mock/合成数据迹象，违反诚实数据契约:\n  - %s",
		ErrSchemaValidationFailed, dataPolicy, strings.Join(shown, "\n  - "))
}

// AuditCarrierOntologyContract rejects generated carrier-affiliation apps that
// ask the ontology/DaaS API for invented raw fields. The ontology docs expose
// AviationCarrier longitude/latitude as "longitude"/"latitude"; generated apps
// have repeatedly guessed "curLongitude"/"curLatitude", which the upstream
// rejects with HTTP 400 after deployment. This audit is intentionally scoped to
// real-data carrier apps so unrelated domains can use similarly named local
// fields without being blocked.
func AuditCarrierOntologyContract(projectDir, dataPolicy string, dataSkills []string) error {
	if dataPolicy != "live_api" && dataPolicy != "mock_then_api" {
		return nil
	}
	if !hasCarrierAffiliationSkill(dataSkills) {
		return nil
	}

	var findings []string
	forbidden := []string{"curLongitude", "curLatitude"}
	_ = filepath.WalkDir(projectDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if auditSkipSegment(d.Name()) {
				return filepath.SkipDir
			}
			return nil
		}
		rel, rerr := filepath.Rel(projectDir, path)
		if rerr != nil {
			return nil
		}
		relSlash := filepath.ToSlash(rel)
		if auditSkipFile(relSlash, d.Name()) || !isDataLayerFile(relSlash) {
			return nil
		}
		ext := strings.ToLower(filepath.Ext(d.Name()))
		if !auditedExts[ext] {
			return nil
		}
		raw, rerr := os.ReadFile(path)
		if rerr != nil || len(raw) > honestDataMaxFileBytes {
			return nil
		}
		body := string(raw)
		for _, field := range forbidden {
			if strings.Contains(body, field) {
				findings = append(findings, fmt.Sprintf("%s: forbidden ontology field %s; use documented longitude/latitude", relSlash, field))
			}
		}
		for _, field := range []string{"refHMId", "recordTime", "speed", "heading"} {
			if containsEntityQuotedField(body, "AircraftCarrierTrackLog", field) {
				findings = append(findings, fmt.Sprintf("%s: forbidden AircraftCarrierTrackLog field %s; use documented refAviationCarrier/trackInitTime/longitude/latitude", relSlash, field))
			}
		}
		if containsEntityQuotedField(body, "MaritimeBaseCombatPlatform", "callsign") {
			findings = append(findings, fmt.Sprintf("%s: forbidden MaritimeBaseCombatPlatform field callsign; use documented mmsi/id fallback", relSlash))
		}
		if containsRawADSNullFilter(body) {
			findings = append(findings, fmt.Sprintf("%s: RawADSData uses unsupported is not + null filter; omit the filter instead", relSlash))
		}
		return nil
	})

	if len(findings) == 0 {
		return nil
	}
	shown := findings
	if len(shown) > honestDataMaxFindings {
		shown = shown[:honestDataMaxFindings]
		shown = append(shown, fmt.Sprintf("... %d more findings omitted", len(findings)-honestDataMaxFindings))
	}
	return fmt.Errorf("%w: carrier ontology field contract violation\n  - %s",
		ErrSchemaValidationFailed, strings.Join(shown, "\n  - "))
}

func containsEntityQuotedField(body, entity, field string) bool {
	for start := strings.Index(body, entity); start >= 0; {
		end := start + 1000
		if end > len(body) {
			end = len(body)
		}
		window := body[start:end]
		fieldList := firstBracketedSegment(window)
		if strings.Contains(fieldList, `"`+field+`"`) || strings.Contains(fieldList, `'`+field+`'`) {
			return true
		}
		next := strings.Index(body[start+len(entity):], entity)
		if next < 0 {
			break
		}
		start += len(entity) + next
	}
	return false
}

func firstBracketedSegment(s string) string {
	open := strings.Index(s, "[")
	if open < 0 {
		return ""
	}
	depth := 0
	for i := open; i < len(s); i++ {
		switch s[i] {
		case '[':
			depth++
		case ']':
			depth--
			if depth == 0 {
				return s[open : i+1]
			}
		}
	}
	return s[open:]
}

func containsRawADSNullFilter(body string) bool {
	for start := strings.Index(body, "RawADSData"); start >= 0; {
		end := start + 2000
		if end > len(body) {
			end = len(body)
		}
		window := body[start:end]
		if regexp.MustCompile(`logic\s*:\s*["']is not["']`).MatchString(window) &&
			regexp.MustCompile(`condition\s*:\s*null`).MatchString(window) {
			return true
		}
		next := strings.Index(body[start+len("RawADSData"):], "RawADSData")
		if next < 0 {
			break
		}
		start += len("RawADSData") + next
	}
	return false
}

func hasCarrierAffiliationSkill(dataSkills []string) bool {
	for _, skill := range dataSkills {
		if strings.Contains(strings.ToLower(skill), "carrier-affiliation-data-skill") {
			return true
		}
	}
	return false
}

const (
	honestDataMaxFindings  = 12
	honestDataMaxFileBytes = 1 << 20 // 1 MiB — skip minified/vendored blobs
)

var auditedExts = map[string]bool{
	".js": true, ".jsx": true, ".ts": true, ".tsx": true,
	".mjs": true, ".cjs": true, ".json": true, ".vue": true,
	".html": true, ".svelte": true,
}

// auditSkipSegment reports whether a directory segment should prune the walk
// (vendored / build output / test directories). Lower-cased comparison.
func auditSkipSegment(name string) bool {
	switch strings.ToLower(name) {
	case "node_modules", "dist", "build", "out", "coverage", ".git",
		".cache", ".factory", ".next", ".vite", ".nuxt", "storybook-static",
		"test", "tests", "__tests__", "__mocks__", "fixtures", "e2e",
		"e2e-tests", "spec", "specs", "storybook", "mocks":
		return true
	}
	return false
}

// testBaseRe matches test/spec/story basenames: test.js, foo.test.js,
// foo_test.js, helper.spec.ts, card.stories.jsx.
var testBaseRe = regexp.MustCompile(`(?i)(^|[\._-])(test|spec|stories)(\.[a-z0-9]+)+$`)

// auditSkipFile reports whether a regular file should be skipped: test/story
// files, minified bundles, and lock files.
func auditSkipFile(relSlash, name string) bool {
	base := strings.ToLower(name)
	if strings.HasSuffix(base, ".min.js") || strings.HasSuffix(base, ".min.css") {
		return true
	}
	switch base {
	case "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb":
		return true
	}
	if testBaseRe.MatchString(base) {
		return true
	}
	return false
}

var (
	mockSourceStemRe   = regexp.MustCompile(`^mock(s)?([-_]?data)?$`)
	isMockTrueRe       = regexp.MustCompile(`(?i)isMock\s*:\s*true`)
	mockProviderRe     = regexp.MustCompile(`(?i)mock[ _-]?data[ _-]?provider`)
	mockIdentRe        = regexp.MustCompile(`(?i)\b(MOCK_[A-Z0-9_]+|mockData|mockTide|mockWind|mockCells|fakeData|sampleData|demoData)\b`)
	syntheticCommentRe = regexp.MustCompile(`(?i)(//|/\*|\*|#)\s*(假数据|演示数据|合成数据|模拟数据|mock data|synthetic|fake data)`)
)

// isDataLayerFile reports whether rel points at a data-acquisition / data-store
// file: anything under the conventional data dirs, or a file whose stem denotes
// data/provider/service/store. This scope keeps the identifier/comment/Math
// rules off pure presentation code.
func isDataLayerFile(rel string) bool {
	rel = strings.ToLower(rel)
	for _, d := range []string{
		"src/data/", "src/providers/", "src/services/", "src/api/",
		"src/mock/", "src/store/", "src/stores/", "src/redux/",
		"src/model/", "src/models/", "src/repository/", "src/repositories/",
	} {
		if strings.HasPrefix(rel, d) {
			return true
		}
	}
	stem := strings.ToLower(strings.TrimSuffix(filepath.Base(rel), filepath.Ext(rel)))
	for _, suf := range []string{"data", "provider", "service", "store", "mock", "repository"} {
		if strings.HasSuffix(stem, suf) {
			return true
		}
	}
	return false
}
