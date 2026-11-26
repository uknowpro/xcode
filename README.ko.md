# xcode

[English](README.md)

로컬 프로젝트와 OpenAI 호환 Chat Completions API를 연결하는 터미널 앱입니다. 질문에 필요한 코드를 찾고, 변경안을 검토한 뒤 적용하고 테스트할 수 있습니다.

## 설정

Linux, macOS, Windows에서 Node.js 22.5 이상이 필요합니다. 저장소에서 실행하세요.

    npm install -g .
    xcode setup
    xcode profile test

**API 주소, 모델 ID, 토큰**을 입력합니다. 로컬과 원격의 HTTP·HTTPS 주소를 쓸 수 있습니다. /v1 또는 /chat/completions 주소를 사용하세요. 기본 프로필은 새 세션에 적용되며 주소 변경 시 토큰은 유지됩니다. 연결 진단은 일반 채팅, SSE, 함수 호출을 구분해서 표시합니다.

## 프로젝트에서 사용

    cd my-project
    xcode
    xcode ask "재시도 정책은 어디에 있나요?"
    xcode sessions

함수 호출을 지원하는 모델의 경우, xcode가 현재 작업 트리를 검색해 경로와 줄 번호를 알려줍니다. @를 입력하고 Tab을 누르면 경로가 자동완성됩니다. 여러 줄 입력은 /paste로 시작하고 /send로 보냅니다.

코드 변경과 테스트를 함께 하려면

    xcode check add unit -- npm test
    xcode --harness implement --write --checks

1. 변경 요청을 입력하면 여러 파일의 수정·생성안을 준비합니다.
2. /diff에서 방향키나 페이지 키로 검토하고 Esc로 닫습니다. /apply로 적용하거나 /reject로 거절합니다.
3. 적용 후 검증 단계에서 등록한 테스트와 종료 코드를 확인합니다. 필요하면 /check unit으로 직접 실행합니다.

기본은 읽기 전용입니다. 세션에서 /write on은 변경안 작성을, /checks on은 해당 프로젝트에 직접 등록한 명령의 실행을 허용합니다. xcode ask가 검토에서 멈추면 xcode review show, xcode review apply, xcode continue로 이어갈 수 있습니다.

## 설정과 세션 확인

- **전역** · xcode setup에서 기본 모델을 저장하고 xcode profile use <이름>으로 기본값을 바꿉니다. xcode settings에서 모델과 프로젝트 테스트를 확인합니다. 기본 경로는 ~/.xcode입니다. XCODE_HOME으로 경로를 바꾸거나 XCODE_API_TOKEN으로 현재 실행의 토큰을 지정할 수 있습니다.
- **세션** · /settings에서 현재 모델·하네스·권한을 확인합니다. /model이나 /harness로 변경하고, /new, /sessions, /resume으로 세션을 전환합니다.
- **입력** · /attach로 텍스트·이미지·PDF를 첨부합니다. 지원 모델에서 /inputs image on과 /inputs pdf on을 사용하세요. PDF 텍스트는 pdftotext가 설치된 경우 로컬에서 추출할 수 있습니다.
- **하네스** · xcode harness list와 xcode harness show implement로 프리셋을 확인합니다. xcode harness import <이름> <파일>로 커스텀 JSON을 추가하며 .claude/skills와 .xcode/skills의 호환 스킬도 사용할 수 있습니다.

파일 검색은 로컬에서 실행합니다. 선택된 파일 구간, 첨부, 허용된 테스트의 출력은 설정한 모델 주소로 전송됩니다. npm test와 npm run test:install로 검증합니다.
