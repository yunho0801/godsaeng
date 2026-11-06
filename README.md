# 갓생게임

할 일 목록을 게임처럼. 퀘스트를 끝내면 경험치가 쌓이고, 레벨이 오르고, 친구와 연속 달성 기록을 겨룹니다.

## 실행하기

Node.js 18 이상만 있으면 됩니다. 따로 설치할 패키지는 없어요.

```bash
node server.js
```

- 컴퓨터에서: http://localhost:3000
- 휴대폰에서: 컴퓨터와 같은 와이파이에 연결한 뒤, 서버를 켤 때 터미널에 나오는 `http://192.168.x.x:3000` 주소로 접속하세요.
  Windows 방화벽 창이 뜨면 "개인 네트워크"에서 허용해 주세요.
- 휴대폰 브라우저의 "홈 화면에 추가"를 누르면 앱처럼 쓸 수 있어요.

## 인터넷에 공개하기 (Render + Supabase, 무료)

### 1. Supabase — 데이터 저장소
1. https://supabase.com 에 가입하고 **New project**를 만들어요. 지역은 Northeast Asia (Seoul)를 고르세요.
2. 왼쪽 **SQL Editor**에 `supabase/schema.sql` 내용을 붙여 넣고 **Run**을 누르세요.
3. **Project Settings > API**에서 두 값을 복사해 두세요.
   - Project URL → `SUPABASE_URL`
   - **API Keys** 메뉴의 Secret key (`sb_secret_…`) 또는 Legacy 탭의 `service_role` 키 → `SUPABASE_SERVICE_KEY`
   - service_role 키는 비밀번호와 같아요. 코드나 채팅에 붙여 넣지 말고 Render 설정 화면에만 넣으세요.

### 2. GitHub — 코드 올리기
https://github.com/new 에서 빈 저장소를 만든 뒤(README 추가 안 함) 아래 명령을 실행하세요.

```bash
git remote add origin https://github.com/<내 아이디>/godsaeng.git
```

```bash
git push -u origin main
```

### 3. Render — 서버와 주소
1. https://render.com 에 GitHub 계정으로 가입해요.
2. **New > Blueprint**를 누르고 위 저장소를 고르면 `render.yaml` 설정을 읽어요.
3. `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` 값을 넣고 **Apply**를 누르세요.
4. 몇 분 뒤 `https://godsaeng-xxxx.onrender.com` 주소가 생겨요.

무료 서버는 15분 동안 접속이 없으면 잠들어요. 그다음 첫 접속은 30초쯤 걸리고, 이후에는 빨라요. 기록은 Supabase에 있어서 사라지지 않아요.

## 파일 구성

| 파일 | 설명 |
|---|---|
| `PROMPT.md` | 기획서를 바탕으로 다시 정리한 제작 프롬프트 |
| `server.js` | API 서버와 정적 파일 서버 (Node.js 표준 모듈만 사용) |
| `public/index.html` | 웹 앱 전체 (Tailwind CDN, Pretendard, Iconify Solar) |
| `public/manifest.webmanifest`, `public/icon.svg` | 홈 화면 추가용 정보와 아이콘 |
| `data/db.json` | 로컬 실행 시 저장 파일 (처음 가입할 때 생겨요) |
| `render.yaml`, `supabase/schema.sql` | 배포 설정과 Supabase 테이블 |

## 친구 기능 혼자 시험해 보기

일반 창과 시크릿 창(또는 다른 브라우저)에서 계정을 하나씩 만든 뒤, 프로필의 고유 ID(`GS-XXXXXX`)로 서로 친구 요청을 보내 보세요.

## 참고

- 일일 퀘스트는 매일 0시, 주간 퀘스트는 매주 월요일 0시(한국 시간)에 초기화돼요.
- 데이터는 이 컴퓨터의 `data/db.json`에만 저장돼요. 인터넷에 공개하려면 HTTPS가 되는 서버에 올려야 해요.
