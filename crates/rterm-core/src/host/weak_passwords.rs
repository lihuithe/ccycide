//! 固定密码的弱口令检测（《安全审查报告》M4）。
//!
//! 不依赖外部词库：内置一份几百条的常见密码词干 + 键盘序列 + "词 + 年份/数字/符号"模式检测。
//! 思路是把密码归一化（小写、常见 leet 替换）后去掉首尾的数字和符号得到"词干"，词干在常见词表里就判为弱。
//! 这样 `Summer2024`、`Password123!`、`P@ssw0rd!!`、`Iloveyou2024` 都会命中，而带有自己词汇的长口令（`Blue-Fox-Jumps-77`）不会。

/// 常见密码、常见单词、季节/月份/星期、拼音、品牌等词干（全小写，不含首尾数字符号）。
pub const COMMON_STEMS: &[&str] = &[
    // 最常见的密码
    "password",
    "passwd",
    "pass",
    "passw0rd",
    "pa55word",
    "pa55w0rd",
    "mypassword",
    "mypass",
    "newpassword",
    "oldpassword",
    "yourpassword",
    "thepassword",
    "letmein",
    "welcome",
    "admin",
    "administrator",
    "root",
    "toor",
    "user",
    "username",
    "guest",
    "login",
    "master",
    "hello",
    "secret",
    "changeme",
    "default",
    "test",
    "tester",
    "testing",
    "temp",
    "temporary",
    "demo",
    "access",
    "trustno",
    "freedom",
    "whatever",
    "abc",
    "abcd",
    "abcde",
    "abcdef",
    "abcdefg",
    "abcdefgh",
    "abcdefghi",
    "abcdefghij",
    "aaa",
    "aaaa",
    "aaaaa",
    "aaaaaa",
    "zzzz",
    "xxxx",
    // 键盘序列
    "qwerty",
    "qwertyui",
    "qwertyuiop",
    "qwert",
    "qwer",
    "qwe",
    "qweasd",
    "qweasdzxc",
    "qweqwe",
    "asdf",
    "asdfg",
    "asdfgh",
    "asdfghj",
    "asdfghjk",
    "asdfghjkl",
    "asdasd",
    "zxcv",
    "zxcvb",
    "zxcvbn",
    "zxcvbnm",
    "zxczxc",
    "qazwsx",
    "qazwsxedc",
    "qazxsw",
    "qaz",
    "wsx",
    "zaq1zaq1",
    "zaq12wsx",
    "zaq1xsw2",
    "1qaz2wsx",
    "1qazxsw2",
    "1q2w3e4r",
    "1q2w3e4r5t",
    "q1w2e3r4",
    "q1w2e3r4t5",
    "1qaz2wsx3edc",
    "qazwsxedcrfv",
    "poiuyt",
    "poiuytrewq",
    "lkjhgf",
    "lkjhgfdsa",
    "mnbvcxz",
    "mnbvcx",
    "plokij",
    "pl,okm",
    "ytrewq",
    "asdzxc",
    "zxcasd",
    "qwaszx",
    "1234qwer",
    "qwer1234",
    "q1w2e3",
    "a1b2c3",
    "abc123",
    "abcd1234",
    "qwe123",
    "123qwe",
    "123abc",
    "1a2b3c",
    "1a2b3c4d",
    "a1b2c3d4",
    "aa123456",
    "a123456",
    "a1234567",
    "a12345678",
    "aa12345678",
    // 流行词
    "iloveyou",
    "iloveu",
    "ilovemyself",
    "ilovelife",
    "iloveme",
    "loveyou",
    "loveme",
    "lovely",
    "love",
    "lover",
    "lovers",
    "sunshine",
    "princess",
    "angel",
    "angels",
    "baby",
    "babygirl",
    "monkey",
    "dragon",
    "baseball",
    "football",
    "soccer",
    "basketball",
    "hockey",
    "tennis",
    "golf",
    "batman",
    "superman",
    "spiderman",
    "pokemon",
    "starwars",
    "matrix",
    "shadow",
    "ninja",
    "mustang",
    "cheese",
    "computer",
    "internet",
    "michael",
    "jennifer",
    "jordan",
    "jessica",
    "ashley",
    "daniel",
    "thomas",
    "robert",
    "andrew",
    "charlie",
    "tigger",
    "ginger",
    "hunter",
    "buster",
    "harley",
    "ranger",
    "maggie",
    "pepper",
    "killer",
    "jesus",
    "jesuschrist",
    "god",
    "blessed",
    "faith",
    "cookie",
    "chocolate",
    "flower",
    "summer",
    "winter",
    "spring",
    "autumn",
    "fall",
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
    "birthday",
    "happy",
    "happybirthday",
    "family",
    "friends",
    "friend",
    "money",
    "dollar",
    "freedom",
    "liberty",
    "america",
    "london",
    "paris",
    "tokyo",
    "newyork",
    "california",
    "texas",
    "singapore",
    "starbucks",
    "pizza",
    "hamburger",
    // 品牌与技术
    "windows",
    "microsoft",
    "google",
    "apple",
    "samsung",
    "huawei",
    "xiaomi",
    "oppo",
    "vivo",
    "linux",
    "ubuntu",
    "debian",
    "centos",
    "android",
    "iphone",
    "ipad",
    "macbook",
    "facebook",
    "twitter",
    "instagram",
    "youtube",
    "netflix",
    "amazon",
    "ebay",
    "paypal",
    "github",
    "gitlab",
    "docker",
    "kubernetes",
    "python",
    "java",
    "javascript",
    "rust",
    "nodejs",
    "mysql",
    "redis",
    "oracle",
    "server",
    "serveradmin",
    "remote",
    "terminal",
    "console",
    "shell",
    "bash",
    "claude",
    "anthropic",
    "openai",
    "chatgpt",
    "rterm",
    "remoteterm",
    "remotedesktop",
    "teamviewer",
    "anydesk",
    "vpn",
    "wifi",
    "router",
    "network",
    "internet",
    "system",
    "sysadmin",
    "database",
    "backup",
    "service",
    "support",
    "manager",
    "operator",
    "company",
    "office",
    "work",
    "home",
    "school",
    "student",
    "teacher",
    "company",
    "dev",
    "developer",
    "devops",
    // 拼音与中文网络常用
    "woaini",
    "aini",
    "woaini1314",
    "nihao",
    "nihaoma",
    "zhongguo",
    "china",
    "beijing",
    "shanghai",
    "guangzhou",
    "shenzhen",
    "hangzhou",
    "chengdu",
    "wuhan",
    "nanjing",
    "chongqing",
    "mima",
    "woshishui",
    "zhangsan",
    "lisi",
    "wangwu",
    "taobao",
    "tencent",
    "alibaba",
    "baidu",
    "weixin",
    "wechat",
    "xiaoming",
    "xiaohong",
    "xiaoli",
    "laowang",
    "zhuzhu",
    "baobao",
    "mingming",
    "wocao",
    "wobuzhidao",
    "aaaaaa",
    "qqqqqq",
    "qq",
    "qqqq",
    "qqqqq",
    "wasd",
    "wang",
    "zhang",
    "liu",
    "chen",
    "yang",
    "huang",
    "zhao",
    "zhou",
    "wu",
    "xu",
    "sun",
    "ma",
    "hu",
    "zhu",
    "guo",
    "he",
    "gao",
    "lin",
    "luo",
    "zheng",
    "liang",
    "xie",
    "tang",
    "han",
    "feng",
];

/// 键盘上连续的按键序列。密码里出现其中任意 5 个及以上的连续片段（正向或反向）就判为弱。
const KEYBOARD_WALKS: &[&str] = &[
    "qwertyuiop",
    "asdfghjkl",
    "zxcvbnm",
    "1234567890",
    "qazwsxedcrfvtgbyhnujmikolp",
    "1qaz2wsx3edc4rfv5tgb6yhn7ujm8ik9ol0p",
    "poiuytrewq",
    "lkjhgfdsa",
    "mnbvcxz",
    "zaq1xsw2cde3vfr4bgt5nhy6mju7",
];

/// 字符是否按顺序连续（`abcde` / `54321` 这类）的最小长度。
const SEQ_MIN: usize = 5;
/// 单字符连续重复的最小长度。
const REPEAT_MIN: usize = 5;

fn leet(s: &str, one_as: char) -> String {
    s.chars()
        .map(|c| match c {
            '@' | '4' => 'a',
            '3' => 'e',
            '1' => one_as,
            '!' | '|' => 'i',
            '0' => 'o',
            '$' | '5' => 's',
            '7' => 't',
            '8' => 'b',
            other => other,
        })
        .collect()
}

fn is_edge(c: char) -> bool {
    c.is_ascii_digit() || c.is_ascii_punctuation() || c.is_whitespace()
}

fn strip_tail(s: &str) -> &str {
    s.trim_end_matches(is_edge)
}

fn strip_both(s: &str) -> &str {
    s.trim_matches(is_edge)
}

/// 含有 `SEQ_MIN` 个及以上按字母表/数字顺序连续（升序或降序）的字符。
fn has_sequence(s: &str) -> bool {
    let b: Vec<u8> = s
        .bytes()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect();
    if b.len() < SEQ_MIN {
        return false;
    }
    let mut up = 1;
    let mut down = 1;
    for w in b.windows(2) {
        let same_kind = w[0].is_ascii_digit() == w[1].is_ascii_digit();
        if same_kind && w[1] == w[0].wrapping_add(1) {
            up += 1;
        } else {
            up = 1;
        }
        if same_kind && w[0] == w[1].wrapping_add(1) {
            down += 1;
        } else {
            down = 1;
        }
        if up >= SEQ_MIN || down >= SEQ_MIN {
            return true;
        }
    }
    false
}

fn has_repeat(s: &str) -> bool {
    let mut run = 1;
    let mut prev: Option<char> = None;
    for c in s.chars() {
        if Some(c) == prev {
            run += 1;
            if run >= REPEAT_MIN {
                return true;
            }
        } else {
            run = 1;
        }
        prev = Some(c);
    }
    false
}

fn has_keyboard_walk(lower: &str) -> bool {
    let chars: Vec<char> = lower.chars().collect();
    if chars.len() < SEQ_MIN {
        return false;
    }
    for w in chars.windows(SEQ_MIN) {
        let frag: String = w.iter().collect();
        let rev: String = w.iter().rev().collect();
        if KEYBOARD_WALKS
            .iter()
            .any(|k| k.contains(&frag) || k.contains(&rev))
        {
            return true;
        }
    }
    false
}

/// 弱口令检查。返回弱的原因（给用户看的短语），不弱返回 `None`。
pub fn weakness(pw: &str, device_code: &str) -> Option<&'static str> {
    let lower = pw.to_lowercase();
    if !device_code.is_empty() && lower.contains(&device_code.to_lowercase()) {
        return Some("不能包含设备码");
    }
    let distinct: std::collections::HashSet<char> = lower.chars().collect();
    if distinct.len() <= 3 {
        return Some("字符种类太少");
    }
    if has_repeat(&lower) {
        return Some("含有连续重复的字符");
    }
    if has_sequence(&lower) {
        return Some("含有连续的字母或数字序列（如 12345、abcde）");
    }
    if has_keyboard_walk(&lower) {
        return Some("含有键盘上相邻的按键序列（如 qwert、asdfg）");
    }
    // 词干：归一化后去掉首尾的数字和符号，在常见词表里就是弱口令（涵盖"季节 + 年份"等模式）
    // 先去掉首尾，再做 leet 还原（否则 `P@ssw0rd!!!!` 末尾的 `!` 会先被还原成字母）
    for base in [lower.as_str(), strip_tail(&lower), strip_both(&lower)] {
        for cand in [base.to_string(), leet(base, 'i'), leet(base, 'l')] {
            if !cand.is_empty() && COMMON_STEMS.contains(&cand.as_str()) {
                return Some("是常见密码或常见单词加数字");
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_is_big_enough_and_lowercase() {
        assert!(COMMON_STEMS.len() >= 300, "只有 {} 条", COMMON_STEMS.len());
        for s in COMMON_STEMS {
            assert_eq!(*s, s.to_lowercase(), "{s} 必须是小写");
        }
    }

    #[test]
    fn report_examples_are_weak() {
        for pw in [
            "Passw0rd!",
            "Aa123456",
            "zaq12wsx",
            "baseball",
            "Summer2024",
            "qwer1234",
            "12345678a",
            "iloveyou2",
        ] {
            assert!(weakness(pw, "123456789").is_some(), "{pw} 应判为弱");
        }
    }

    #[test]
    fn long_variants_are_weak() {
        for pw in [
            "Password123!",
            "P@ssw0rd!!!!",
            "Qwerty12345!",
            "Iloveyou2024!",
            "Baseball2024",
            "Winter@2025",
            "Admin@12345",
            "Welcome@2024",
            "Letmein#2024",
            "Spring2025!!",
            "Autumn-2024",
            "Zaq12wsx!!!!",
            "MyP@ssw0rd-2026",
            "abcdefghij1A",
        ] {
            assert!(weakness(pw, "123456789").is_some(), "{pw} 应判为弱");
        }
    }

    #[test]
    fn strong_passwords_pass() {
        for pw in [
            "Xk9#mPq2vL",
            "correct horse battery staple",
            "tr0ub4dor&3xyz",
            "9a#4%7&2*1Kq",
            "Blue-Fox-Jumps-77",
            "雨后的清晨Ab7!xYz",
        ] {
            assert_eq!(weakness(pw, "123456789"), None, "{pw} 不应判为弱");
        }
    }

    #[test]
    fn sequences_repeats_and_walks() {
        assert!(has_sequence("xx12345yy"));
        assert!(has_sequence("xx98765yy"));
        assert!(has_sequence("xxabcdeyy"));
        assert!(!has_sequence("1a2b3c4d"));
        assert!(!has_sequence("x1234y"));
        assert!(has_repeat("ab11111c"));
        assert!(!has_repeat("ab1111c"));
        assert!(has_keyboard_walk("xxqwertxx"));
        assert!(has_keyboard_walk("xxtrewqxx"));
        assert!(!has_keyboard_walk("qweXrty"));
    }

    #[test]
    fn device_code_is_rejected() {
        assert_eq!(
            weakness("Zk#482913675#x", "482913675"),
            Some("不能包含设备码")
        );
    }
}
