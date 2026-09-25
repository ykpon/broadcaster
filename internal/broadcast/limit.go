package broadcast

import (
	"errors"
	"math/big"
	"strings"
)

// ViewerLimit holds a positive decimal integer without imposing a product cap.
type ViewerLimit struct {
	value *big.Int
}

func ParseViewerLimit(raw string) (ViewerLimit, error) {
	if raw == "" || strings.Trim(raw, "0123456789") != "" {
		return ViewerLimit{}, errors.New("viewer limit must be decimal digits")
	}
	value, ok := new(big.Int).SetString(raw, 10)
	if !ok || value.Sign() <= 0 {
		return ViewerLimit{}, errors.New("viewer limit must be positive")
	}
	return ViewerLimit{value: value}, nil
}

func (l ViewerLimit) String() string {
	return new(big.Int).Set(l.value).String()
}

func (l ViewerLimit) Allows(occupied int) bool {
	return l.value.Cmp(new(big.Int).SetUint64(uint64(occupied))) >= 0
}
