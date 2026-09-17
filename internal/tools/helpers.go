package tools

import (
	"strconv"
	"unicode/utf8"
)

func utf8Valid(raw []byte) bool { return utf8.Valid(raw) }

func itoa(value int) string { return strconv.Itoa(value) }
