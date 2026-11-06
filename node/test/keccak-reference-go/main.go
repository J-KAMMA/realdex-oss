package main
import("bufio";"os";"fmt";"encoding/hex";"golang.org/x/crypto/sha3")
func main(){s:=bufio.NewScanner(os.Stdin);s.Buffer(make([]byte,1024),1024*1024);for s.Scan(){b,e:=hex.DecodeString(s.Text());if e!=nil{panic(e)};h:=sha3.NewLegacyKeccak256();h.Write(b);fmt.Printf("%x\n",h.Sum(nil))};if s.Err()!=nil{panic(s.Err())}}
