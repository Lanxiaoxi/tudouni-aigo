package release

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
)

// SampleDocx builds a minimal but valid Word document, one paragraph per argument.
//
// It exists for two callers that need a real file and must not depend on anything on
// the machine: `tools/release` converts it with the *staged* extractor (the
// self-check that `read_document` works in the package, the counterpart of the
// "grep registered" check), and the builtin tests convert it with the vendored one.
// Generating it beats committing a binary fixture: nobody has to wonder whether it
// still opens, and a change of the extractor that stops reading it fails loudly.
func SampleDocx(paragraphs ...string) ([]byte, error) {
	var body bytes.Buffer
	for _, text := range paragraphs {
		body.WriteString("<w:p><w:r><w:t xml:space=\"preserve\">")
		if err := xml.EscapeText(&body, []byte(text)); err != nil {
			return nil, err
		}
		body.WriteString("</w:t></w:r></w:p>")
	}

	parts := []struct{ name, content string }{
		{"[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
			`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
			`<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
			`<Default Extension="xml" ContentType="application/xml"/>` +
			`<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
			`</Types>`},
		{"_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
			`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
			`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
			`</Relationships>`},
		{"word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
			`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
			body.String() + `</w:body></w:document>`},
	}

	var out bytes.Buffer
	archive := zip.NewWriter(&out)
	for _, part := range parts {
		writer, err := archive.Create(part.name)
		if err != nil {
			return nil, err
		}
		if _, err := writer.Write([]byte(part.content)); err != nil {
			return nil, err
		}
	}
	if err := archive.Close(); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}
