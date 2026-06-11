# 🔖 북마크 정리기

X(트위터) 북마크를 카테고리·폴더로 정리하는 도구입니다.

## 사용 방법

x-bookmark-extension.zip(확장프로그램)을 설치해서 북마크를 .csv로 추출한다.
https://drive.google.com/file/d/1MamyLBMk9zFe54uMGu9b2t_QzuwoOuN4/view?usp=sharing
- 태그 규칙을 원하는 대로 설정한다. (content.js 파일)
- (예시) const TAG_RULES = [
      { tag: 'TRPG',       keywords: ['TRPG', 'roll20', '롤20', '코코포리아'] },
      { tag: 'CoC',       keywords: ['크툴루', '크툴루의 부름', 'CoC', '수호자', '탐사자', '키퍼', '러브크래프트'] },
      { tag: 'DnD',       keywords: ['던전앤드래곤', '던전 앤 드래곤', 'DnD', 'D&D', '디앤디'] },
      { tag: '인세인',     keywords: ['인세인', 'insane', '봉마인'] },


### HTML 버전 (인터넷 브라우저)
`index.html` 파일을 다운로드 후 더블클릭하면 바로 사용할 수 있어요.

### Windows 앱 (.exe)
[Releases](../../releases) 페이지에서 최신 `.exe` 파일을 다운로드하세요.
- `북마크정리기 Setup x.x.x.exe` → 설치형
- `북마크정리기 x.x.x.exe` → 무설치 포터블

---

## 참고
- 데이터는 브라우저/앱에 자동 저장됩니다.
- 백업: **환경설정 → 백업 내보내기(.json)**
