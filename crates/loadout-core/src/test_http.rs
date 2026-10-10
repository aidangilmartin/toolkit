//! A tiny HTTP server answering fixed paths, for testing the network code
//! without leaving the machine.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::thread;
use std::time::Duration;

use ureq::Agent;

pub struct Reply {
    pub status: u16,
    pub headers: Vec<(&'static str, String)>,
    pub body: Vec<u8>,
}

impl Reply {
    pub fn ok(body: impl Into<Vec<u8>>) -> Self {
        Self {
            status: 200,
            headers: Vec::new(),
            body: body.into(),
        }
    }

    pub fn redirect(to: &str) -> Self {
        Self {
            status: 302,
            headers: vec![("Location", to.to_string())],
            body: Vec::new(),
        }
    }
}

/// Serve `routes` on a free local port (404 for anything else) and return the port.
pub fn serve(routes: HashMap<String, Reply>) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut request_line = String::new();
            if reader.read_line(&mut request_line).is_err() {
                continue;
            }
            loop {
                let mut line = String::new();
                match reader.read_line(&mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) if line == "\r\n" => break,
                    Ok(_) => {}
                }
            }
            let path = request_line.split(' ').nth(1).unwrap_or("/");
            let not_found = Reply {
                status: 404,
                headers: Vec::new(),
                body: b"{}".to_vec(),
            };
            let reply = routes.get(path).unwrap_or(&not_found);
            let mut head = format!(
                "HTTP/1.1 {} X\r\nContent-Length: {}\r\nConnection: close\r\n",
                reply.status,
                reply.body.len()
            );
            for (name, value) in &reply.headers {
                head.push_str(&format!("{name}: {value}\r\n"));
            }
            head.push_str("\r\n");
            let mut stream = stream;
            let _ = stream.write_all(head.as_bytes());
            let _ = stream.write_all(&reply.body);
        }
    });
    port
}

/// An agent that never goes through a proxy from the environment.
pub fn agent() -> Agent {
    Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(5)))
        .proxy(None)
        .build()
        .into()
}
