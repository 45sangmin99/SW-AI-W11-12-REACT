// 문의 데이터 불러오기·검증 (R-09 스키마, F-03 오류 처리). 순수 함수 + fetch 한 곳.
import { CONFIG } from "./config.js";
//문의 데이터 한건이 정상인지 검사 config.js파일에서 CONFIG라는 이름의 항목을 가져옴 =>:function생략 =>이거 안쓰면  function(r) 이렇게써야함
const isValidInquiry = (r) => //r이라는데이터를 받아서 정상적인 문의인지 검사하는 함수 만듦
  r !== null &&
  typeof r === "object" &&//typeof : 데이터의 자료형을 확인하는 JavaScript 연산자 === : 값과 자료형이 모두 같은지 비교
  Number.isInteger(r.id) &&//id가 정수인지 비교 정수이면 통과
  CONFIG.CATEGORIES.includes(r.category) &&//문의 카테고리가 허용된값인지 검사 CONFIG.CATEGORIES = config.js에서 가져온 카테고리 배열 .includes=배열안에 특정값이 있는지 확인하는 내장 메서드
  typeof r.text === "string" &&//문의내용이 문자열인지 검사
  typeof r.app_version === "string" &&//앱버전이 문자열인지 검사
  r.app_version.trim() !== "" &&//앱버전의 문자열이 공백인지 확인.trim()앞뒤 공백 제거
  CONFIG.DEVICES.includes(r.device) &&//설정파일에 등로된 기기 종류가 허용된 값인지 확인
  typeof r.created_at === "string" &&//생성날짜가 문자열인지 확인
  !Number.isNaN(Date.parse(r.created_at));//Date.parse() 날짜 문자열을 날짜로 해석하고 밀리초 숫자로 변환 Number.isNaN()값이 NaN인지 확인 ! = 결과를 반대로 뒤집는 not 연산자  

/**
 * 불러온 JSON을 검증해서 화면이 쓸 수 있는 형태로 만든다.
 * 형식이 틀린 레코드는 건너뛰고 몇 건을 건너뛰었는지 알려준다 (한 건 때문에 화면 전체가 멈추지 않게).
 * 배열 자체가 아니면 에러를 던진다.
 * @param json 배열([...]) 또는 { meta, inquiries }
 * //함수가 작동하기 위해 외부에서 채워줘야하는 입력값(재료)를 명시 이 함수를 쓰려면 'json'이라는 재료를 전달해야 하는데,그 형태는 배열( [ ] )이거나 객체( { } )여야함
 * @returns { inquiries, meta, skipped }
 * // 함수의 실행이 끝나면, 결과물로 inquiries, meta, skipped라는 열쇠(Key)들을 가진 하나의 묶음(객체)을 돌려줘야함
 *전체 데이터 배열을 검사하고 정리*/
export function parseDataset(json) {
  const list = Array.isArray(json) ? json : json && Array.isArray(json.inquiries) ? json.inquiries : null;
  if (!list) throw new Error("문의 데이터 형식이 올바르지 않습니다. (배열 또는 { inquiries: [...] } 이어야 합니다)");
  const inquiries = list.filter(isValidInquiry);
  const meta = !Array.isArray(json) && json.meta && typeof json.meta === "object" ? json.meta : {};
  return { inquiries, meta, skipped: list.length - inquiries.length };
}

/** 서버에서 공용 샘플 JSON을 가져온다. 네트워크·HTTP·JSON 오류는 사람이 읽을 수 있는 메시지로 바꿔 던진다 async:비동기 함수로 선언(비동기:서버에서 데이터 가져오는 작업 시간걸리는 동안 프로그램이 무작정 기다리지않고 다른 작업을 진행 할 수 있게 하는 방식)url:데이터 가져올 주소 fetchFn 데이터 가져오는 기능 */
export async function loadDataset(url, fetchFn = (...args) => fetch(...args)) {
  let response;//let 처음에는 값이 없고 새로운 값 할당할때
  try {//try 실행해볼 코드
    response = await fetchFn(url);//await 비동기 작업이 끝날때 까지 해당 작업의 결과를 기다림
  } catch {//catch 실행중 오류가 발생했을때 처리하는 코드
    throw new Error("문의 데이터를 불러오지 못했습니다. 네트워크 연결이나 서버 실행 여부를 확인해 주세요."); //Error만하면 영어에러 내뱉는데 New 붙이면 저렇게 에러 문구 지정해서 반환가능
  }
  if (!response.ok) throw new Error(`문의 데이터를 불러오지 못했습니다. (HTTP ${response.status})`);//.ok 통신이 성공적으로 처리됐는지 알려주는 속성 HTTP 응답이 성공 범위인지 나타내는 속성 200번대 응답 true 404 반환하면 false response.status http 상태코드 알려줌 만약 서버 응답이 정상이 아니라면 몇번에러 코드 때문에 실패했는지(response.status) 적힌 새로운 한글 에러를 만들어서 바깥으로 던져라
  //json 변환 
  let json;//json 변수하나 선언 let은 try블록 안에서 변수에 값을 새로 채워넣어야함
  try {
    json = await response.json();//await 데이터를 해독하는데 시간 걸려서 작업이 완전히 끝날때까지 기다렸다가 그 결과를 json에 담음 response.json() 서버가 보내준 원본 데이터 덩러리를 자바 스크립트 객체나 배열 형태로 파싱하는 명령어
  } catch {
    throw new Error("문의 데이터가 올바른 JSON이 아닙니다.");
  }
  return parseDataset(json);
}

/** 필터 선택지: 데이터에 실제로 있는 앱 버전 목록 만들기 (오름차순, "web"은 앱 버전이 아니므로 뺀다)... 전개연산자 map:배열의 각 요소를 원하는 형태로 변환하는 기능 set:중복된 값을 허용되지않는 자료구조 */
export const appVersionsOf = (inquiries) => [...new Set(inquiries.map((q) => q.app_version))].filter((v) => v !== "web").sort();
//문의 목록에서 웹을 제외한 앱 버전들만 중복 없이 뽑아서 정렬하는 함수