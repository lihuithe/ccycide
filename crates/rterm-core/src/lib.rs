//! rterm-core：身份、信令、加密、多路复用、PTY、文件传输。不依赖任何界面库。
//!
//! 模块归属（并行开发时各自只改自己的文件）：
//! - 网络层：identity config secrets api signal relay crypto mux
//! - 被控端：host/*
//! - 主控端与对外门面：controller/* events core
pub mod events;
pub mod link;

pub mod api;
pub mod config;
pub mod config_sig;
pub mod crypto;
pub mod identity;
pub mod mux;
pub mod relay;
pub mod secrets;
pub mod signal;

pub mod controller;
pub mod host;

pub mod core;
pub mod dto;
pub mod error;
pub mod logging;
pub mod settings;

pub mod netutil;
