package audit

import (
	"fmt"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
)

func errInvalidSessionID(name string) error {
	return fmt.Errorf("%s", i18n.T("store.bad_session_id", "name", name))
}
