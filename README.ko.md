# xcode

[English](README.md)

로컬 프로젝트와 OpenAI 호환 Chat Completions API를 연결하는 터미널 앱입니다. 파일명을 몰라도 질문을 입력하면 xcode가 관련 파일을 검색하고 필요한 줄을 읽어 근거와 함께 답변을 스트리밍합니다.

## 설치

Linux, macOS, Windows에서 Node.js 22.5 이상으로 실행합니다. 저장소를 받은 뒤 아래 명령을 실행하세요.

    npm install -g .
    xcode setup
    xcode profile test

설정에는 API 주소, 모델 ID, 토큰을 사용합니다. 로컬 및 원격 HTTP·HTTPS를 지원합니다. /v1로 끝나는 기본 주소나 전체 /v1/chat/completions 주소를 입력할 수 있습니다. 전송 암호화가 필요하면 HTTPS를 사용하세요. 저장한 기본 프로필은 새 세션에 적용되며 API 주소를 변경해도 기존 토큰은 유지됩니다.

    cd my-project
    xcode
    xcode ask "결제 재시도 횟수는 어디에서 설정하나요?"
    xcode sessions
    xcode resume latest

## 세션 사용

- 현재 Git 작업 트리 또는 실행 폴더를 기준으로 파일명과 본문을 검색합니다. 관련 AGENTS.md를 불러오고 파일의 필요한 줄을 읽습니다. 경로를 알고 있으면 @src/config.ts처럼 지정하세요.
- /new로 다른 세션을 시작하고 /sessions, /resume으로 전환합니다. /queue로 대기 메시지를 확인하고 /stop으로 중지, /continue로 재개합니다. /next는 현재 요청을 중지한 뒤 다음 대기 메시지를 보냅니다.
- /retry 60으로 일시적 연결 오류의 재시도를 켤 수 있습니다. 사용량 한도와 요청 제한 응답은 대기열을 멈춥니다.
- /attach "회의 자료.txt"로 텍스트를 첨부합니다. 지원 모델에서 /inputs image on과 /inputs pdf on으로 이미지와 PDF 직접 입력을 켭니다. PDF 직접 입력을 끈 경우 pdftotext가 설치되어 있으면 텍스트를 로컬에서 추출합니다.
- 파일 편집을 쓰려면 --write 또는 /write on을 켭니다. 기존 파일에서 정확히 한 곳에 일치하는 텍스트를 바꿀 수 있습니다. /tools로 세션에서 사용한 도구를 확인합니다.
- 자동 탐색에는 모델 API의 함수 호출 지원이 필요합니다. 채팅 전용 모델은 /inputs tools off를 적용한 뒤 파일을 직접 첨부할 수 있습니다.

## 하네스

직무, 스킬, 단계별 지침과 도구, 완료 기준을 조합할 수 있습니다. 기본, DeepSeek Flash, 코드 리뷰, 구현, 인프라, 문서 작성 프리셋을 제공합니다.

    xcode harness list
    xcode harness roles
    xcode harness show implement
    xcode --harness deepseek-flash
    xcode harness import my-review harness.json

세션에서는 /harness <이름>으로 바꿀 수 있습니다. 프로젝트나 사용자 설정의 .claude/skills, .xcode/skills에서 호환 SKILL.md를 검색합니다. 하네스 JSON 예시는 영어 README에 있습니다.

## 설정과 데이터

기본 설정과 세션은 ~/.xcode에 저장합니다. XCODE_HOME으로 위치를 바꿀 수 있습니다. 설정은 settings.json, 저장한 토큰은 tokens.json에 둡니다. 실행 환경에 XCODE_API_TOKEN이 있으면 해당 값이 우선합니다.

파일 검색은 로컬에서 실행합니다. 선택한 파일 구간과 스킬 문맥, 첨부는 해당 세션에 설정한 모델 API로 전송합니다. ripgrep이 있으면 검색 후보를 찾는 데 사용하며, 설치되어 있지 않아도 기본 검색이 가능합니다.

npm test로 로컬 모의 서버에 대한 모델 연결, 스트림 처리, 파일 탐색, 세션 동작을 검증할 수 있습니다.
