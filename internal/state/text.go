package state

import (
	"fmt"
	"strconv"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
)

// missingKey is the package's single door to user-facing text.
//
// It exists so the import of i18n appears once and the call sites read as what
// they are: "this sentence comes from the catalogue, with these fields".
func missingKey(key string, kv ...any) string {
	return i18n.T(key, kv...)
}

// i18nText is the same door, under the name the catalogue call sites use.
func i18nText(key string, kv ...any) string { return i18n.T(key, kv...) }

func itoa(value int) string { return strconv.Itoa(value) }

func sprintf(format string, args ...any) string { return fmt.Sprintf(format, args...) }
