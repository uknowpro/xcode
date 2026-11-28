# xcode

[English](README.md)

로컬 프로젝트용 터미널 앱입니다. OpenAI 호환 API와 OpenAI Responses, Claude Messages, Gemini GenerateContent를 연결합니다. 질문에 필요한 코드를 찾고, 변경안을 검토한 뒤 적용하고 테스트할 수 있습니다.

## 설정

Linux, macOS, Windows에서 Node.js 22.5 이상이 필요합니다. [GitHub Releases](https://github.com/uknowpro/xcode/releases)에서 .tgz를 내려받아 실행하세요.

    npm install -g ./uknowpro-xcode-0.1.8.tgz
    xcode setup
    xcode profile test

업데이트는 새 .tgz로 같은 설치 명령을 실행하면 됩니다. [설치 안내](docs/install.md)에서 운영체제별 명령, 오프라인 설치, 체크섬 및 xcode completion 사용법을 확인하세요. 기존 모델 프로필, 토큰, 세션을 이어서 사용합니다. 이전 버전으로 돌아갈 때는 [백업과 복구 안내](docs/recovery.md)를 참고하세요. xcode doctor와 xcode settings validate로 환경과 설정을 점검할 수 있습니다. 소스에서 설치할 때는 npm install -g .을 사용합니다.

**API 주소, 모델 ID, 토큰**을 입력합니다. 로컬과 원격의 HTTP·HTTPS 주소를 쓸 수 있습니다. /v1 또는 /chat/completions 주소를 사용하세요. 기본 프로필은 새 세션에 적용되며 주소 변경 시 토큰은 유지됩니다. 연결 진단은 일반 채팅, SSE, 함수 호출을 구분해서 표시합니다. xcode report > xcode-report.json으로 API 주소·토큰·경로·대화 내용을 제외한 진단 리포트를 저장할 수 있습니다. --probe --only chat을 추가하면 실제 연결을 검사합니다.

## 프로젝트에서 사용

    cd my-project
    xcode
    xcode ask "재시도 정책은 어디에 있나요?"
    xcode sessions "재시도 정책"

함수 호출을 지원하는 모델의 경우, xcode가 현재 작업 트리를 검색해 경로와 줄 번호를 알려줍니다. @를 입력하고 Tab을 누르면 경로가 자동완성됩니다. 여러 줄 입력은 /paste로 시작하고 /preview로 확인한 뒤 /send로 보냅니다. 슬래시 명령을 입력할 때 Tab으로 자동완성할 수 있습니다. /status로 세션 설정을 확인하고, /recall로 이전 입력을 찾고, /copy로 응답을 복사합니다. Alt+J는 이전 세션으로 전환합니다. xcode terminal --accessible로 전체 화면 전환 없이 사용할 수 있습니다. xcode terminal --send-key ctrl+x --newline-key ctrl+o로 단축키를 바꿀 수 있습니다. xcode resume으로 미전송 텍스트와 첨부 경로를 복구하거나, xcode draft <ID>로 세션을 열지 않고 초안을 확인합니다.

코드 변경과 테스트를 함께 하려면

    xcode check add unit -- npm test
    xcode harness checks implement unit
    xcode --harness implement --write --checks

1. 변경 요청을 입력하면 파일 수정·생성·이동·삭제안을 준비합니다.
2. /diff에서 검토합니다. /apply는 전체 적용, /apply 경로1 경로2는 선택한 파일만 적용, /reject는 전체 거절입니다. 이동은 원래 경로와 새 경로를 함께 적용합니다. 적용 전 xcode review check로 충돌 위치를 확인할 수 있습니다.
3. 적용 후 검증 단계에서 연결한 테스트와 종료 코드를 확인합니다. /check unit으로 직접 실행할 수 있고, 스크립트에서는 xcode check run unit --json으로 결과를 읽을 수 있습니다. 마지막 검사 결과에 실패가 남아 있으면 xcode ask와 xcode continue는 종료 코드 4를 반환합니다.
4. /changes에서 이력을 확인하고 /undo <ID>로 0.1.2부터 적용한 변경을 되돌립니다. 적용 이후의 수정이 감지되면 충돌을 표시합니다.

기본은 읽기 전용입니다. 세션에서 /write on은 변경안 작성을, /checks on은 해당 프로젝트에 직접 등록한 명령의 실행을 허용합니다. xcode ask가 검토에서 멈추면 xcode review show, xcode review apply, xcode continue로 이어갈 수 있습니다.

## 설정과 세션 확인

- **전역** · xcode setup에서 기본 모델을 저장하고 xcode profile use <이름>으로 기본값을 바꿉니다. xcode settings에서 모델과 프로젝트 테스트를 확인합니다. 기본 경로는 ~/.xcode입니다. XCODE_HOME으로 경로를 바꾸거나 XCODE_API_TOKEN으로 현재 실행의 토큰을 지정할 수 있습니다.
- **세션** · /settings에서 현재 모델·하네스·권한을 확인합니다. /new와 /resume으로 세션을 관리하고, /sessions에서 방향키와 Enter로 전환합니다. 오래된 결정·참조 파일·변경·검증은 요약해 이어가며 /context에서 확인할 수 있습니다.
- **입력** · /attach로 텍스트·이미지·PDF를 첨부합니다. 지원 모델에서 /inputs image on과 /inputs pdf on을 사용하세요. PDF 텍스트는 pdftotext가 설치된 경우 로컬에서 추출할 수 있습니다.
- **하네스** · xcode harness list에서 버그 수정, 리팩터링, API 리뷰, Terraform, Helm, Kubernetes 프리셋을 확인합니다. /harness preview <이름>은 미리보기, /harness <이름>은 전환입니다. 커스텀 JSON과 .claude/skills, .xcode/skills의 호환 스킬도 사용할 수 있습니다.

스킬·MCP·문서 추출·SQLite·자격 증명은 [로컬 연동 안내](docs/local-integrations.md)를 참고하세요. 파일 검색은 로컬에서 실행합니다. 선택된 파일 구간, 첨부, 허용된 테스트의 출력은 설정한 모델 주소로 전송됩니다. npm test와 npm run test:install로 검증합니다.

## 모델 프로필

xcode profile show에서 감지된 어댑터와 프로토콜, 적용 중인 설정을 확인할 수 있습니다.

    xcode setup deepseek
    xcode profile show deepseek
    xcode profile test deepseek --only tools
    xcode --profile deepseek --harness bug-fix --write --checks

표준 DeepSeek Flash, Qwen, Kimi 모델 ID는 자동 감지되고, 처음에는 서버의 기본 추론 설정을 사용합니다. 서버가 지원하면 다음과 같이 지정할 수 있습니다.

    xcode profile tune deepseek --thinking on --effort high
    xcode profile tune deepseek --context-window 65536 --max-tokens 8192 --request-timeout 120

사용자 지정 모델 별칭은 --adapter deepseek-flash로 지정하고, 일반 Chat Completions 호환 모드는 --adapter compatible로 선택합니다. 도구 진단은 도구 결과를 보낸 뒤에도 대화가 이어지는지 확인합니다. 최근 추론 데이터와 도구 기록은 같은 모델 주소에 이어 보내기 위해 세션과 함께 로컬에 저장합니다. 재전송 범위를 넘은 이전 대화는 요약해 사용합니다.

Qwen3.6·Kimi K3는 xcode profile tune <이름> --preset coding으로 모델별 설정을 적용할 수 있습니다. 공식 호스트나 전체 API 주소는 프로토콜을 자동 감지합니다. 그 외 주소에는 --protocol responses, --protocol anthropic, --protocol gemini, --protocol chat-completions를 지정할 수 있습니다.

    xcode profile eval deepseek --against deepseek-tuned

동일한 모델과 주소를 쓰는 두 설정을 임시 프로젝트로 평가합니다. 파일 탐색, 도구 호출, 재개, 테스트, 경로·줄 번호 인용, 소요 시간을 확인합니다. profile eval과 profile test에 --json을 붙이면 결과를 JSON으로 받을 수 있습니다.

검토 화면에서 Tab으로 Diff·Files·Tests를 전환합니다. Files에서 방향키와 Space로 적용할 파일을 고르세요. 선택은 검토에 저장됩니다. 화면을 닫은 뒤 /apply를 실행하세요. implement와 bug-fix 하네스에서 실패한 등록 테스트는 수정안을 최대 두 번 제안합니다. 수정안을 승인하면 같은 테스트를 다시 실행하고 /verification에서 이전 결과와 함께 확인합니다.

[고급 사용법](docs/advanced-workflows.md)
